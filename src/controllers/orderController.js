import { withDatabase, getSystemKeys } from '../utils/config.js';
import { getZohoAccessToken } from '../utils/zohoAuth.js'; // 🔑 Imported from your utils helper!
import admin from 'firebase-admin';

const MONGODB_URI = process.env.MONGODB_URI;

// 🧮 Geolocation mathematical routing formula
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const getISTDateStrings = () => {
  const date = new Date();
  const todayDateOnly = date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const todayKey = todayDateOnly.replace(/-/g, "");
  return { todayDateOnly, todayKey };
};

export const addOrder = async (c) => {
  try {
    const body = await c.req.json();

    // 🔍 Extract identifying info for the Zoho entry
    const mobile = body.mobileNumber || body.mobile || body.Mobile;
    const customerName = body.customerName || body.firstName || body.First_Name;

    // 🛑 Strict Business Rule: Mobile Number is mandatory for Zoho Leads
    if (!mobile) {
      return c.json({ error: "Validation Error: Mobile number field is required to register a lead." }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 🔐 Grab active authorization credentials dynamically
      const zohoToken = await getZohoAccessToken(db);

      // 🏷️ Compute mandatory fallback fields
      const computedLastName = body.lastName || body.Last_Name || body.firstName || body.First_Name || customerName || "Unknown Lead";

      // 📦 Pure Dynamic Payload Builder
      const zohoPayload = {
        data: [
          {
            ...body,
            Last_Name: computedLastName,
            Mobile: String(mobile)
          }
        ]
      };

      console.log(`📡 Forwarding pure dynamic payload to Zoho CRM for customer: ${customerName || 'New Lead'}`);

      const zohoResponse = await fetch("https://www.zohoapis.in/crm/v8/Leads", {
        method: "POST",
        headers: {
          "Authorization": `Zoho-oauthtoken ${zohoToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(zohoPayload)
      });

      if (!zohoResponse.ok) {
        const errDetails = await zohoResponse.text();
        console.error("❌ Zoho Insertion Blocked:", errDetails);
        return c.json({ error: "Failed to create lead inside Zoho CRM module.", details: errDetails }, 500);
      }

      const zohoResult = await zohoResponse.json();
      const statusBlock = zohoResult.data?.[0];

      if (statusBlock?.status !== "success") {
        return c.json({ error: "High level payload error rejected by Zoho.", details: statusBlock }, 400);
      }

      const zohoLeadId = statusBlock.details.id;
      console.log(`✅ Record successfully provisioned. Zoho Lead ID: ${zohoLeadId}`);

      return c.json({
        success: true,
        message: "Order successfully added and synced with Zoho.",
        id: zohoLeadId
      }, 201);
    });
  } catch (err) {
    console.error("❌ AddOrder Error Exception:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const rejectOrder = async (c) => {
  try {
    const body = await c.req.json();
    const { customerMobile, surveyorNumber, comment, receivedAt, name, address } = body;

    if (!comment) {
      return c.json({ error: "Rejection reason (comment) is required" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 1. Safe local insert maintaining standard auditing schemas exclusively
      const adminRejectPayload = {
        name: name,
        address: address,
        surveyorNumber: surveyorNumber || "N/A",
        customerMobile: customerMobile,
        comment: comment,
        time: receivedAt ? new Date(Number(receivedAt)).toISOString() : null
      };

      await db.collection("surveyor_reject").insertOne(adminRejectPayload);
      console.log(`✅ Rejection tracked locally in surveyor_reject collection for surveyor: ${surveyorNumber}`);

      // 2. Look up active Administrator accounts to fetch their FCM tokens
      try {
        const admins = await db.collection("userDetails").find({
          "UserInfo.role": "admin"
        }).toArray();

        let adminTokens = [];

        admins.forEach((adminUser) => {
          const devices = adminUser.PlatformInfo?.devices;
          if (devices && Array.isArray(devices)) {
            devices.forEach((device) => {
              if (device.fcmToken) {
                adminTokens.push(device.fcmToken);
              }
            });
          }
        });

        // 3. Send standard push notification exactly like your assignment style
        if (adminTokens.length > 0) {
          const message = {
            notification: {
              title: "Job Rejected by Surveyor! ⚠️",
              body: `Surveyor ${surveyorNumber} rejected ${name || 'Customer'}. Reason: ${comment}`,
            },
            // 🤖 Force High Priority and Channel Mapping for Android Default Sound
            android: {
              priority: "high",
              notification: {
                channelId: "weekly_summary_channel_v1", // Ties into your high-importance channel
                sound: "default",
              }
            },
            // 🍏 Standard iOS Default Sound Setup
            apns: {
              payload: {
                aps: {
                  sound: "default"
                }
              }
            },
            data: {
              click_action: "FLUTTER_NOTIFICATION_CLICK",
              type: "REJECTION"
            },
            tokens: adminTokens,
          };

          const response = await admin.messaging().sendEachForMulticast(message);
          console.log(`🚀 Rejection alert pushed to Admin devices. Success count: ${response.successCount}`);
        } else {
          console.log(`⚠️ Rejection recorded, but no active Admin FCM tokens found.`);
        }
      } catch (pushErr) {
        console.error("⚠️ Non-blocking warning: Failed to send Admin notification:", pushErr.message);
      }

      return c.json({ success: true, message: "Order rejection cataloged and Admin notified." });
    });
  } catch (err) {
    console.error("❌ RejectOrder Exception Error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

//Delete the deal from surveyor mobile 

export const deleteDeal = async (c) => {
  try {
    // Read dealId from path params OR request JSON body
    const dealId = c.req.param("dealId") || (await c.req.json().catch(() => ({}))).dealId;

    if (!dealId) {
      return c.json({ error: "Validation Error: 'dealId' is required." }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 🗑️ Delete document matching deal_id
      const result = await db.collection("deals").deleteOne({ deal_id: String(dealId) });

      if (result.deletedCount === 0) {
        console.warn(`⚠️ No deal found with deal_id: ${dealId}`);
        return c.json({ success: false, message: "No deal found with the provided dealId." }, 404);
      }

      console.log(`✅ Successfully deleted deal record for deal_id: ${dealId}`);
      return c.json({ 
        success: true, 
        message: `Deal record ${dealId} successfully deleted.`,
        deletedCount: result.deletedCount 
      }, 200);
    });

  } catch (err) {
    console.error("❌ Exception inside deleteDeal controller:", err.message);
    return c.json({ error: err.message }, 500);
  }
};



export const completeOrder = async (c) => {
  try {
    const body = await c.req.json();
    const { customerMobile, surveyorNumber, receivedAt, name, address } = body;

    return await withDatabase(MONGODB_URI, async (db) => {
      // Safe local insert maintaining standard auditing schemas exclusively
      const adminCompletePayload = {
        surveyorNumber: surveyorNumber || "N/A",
        customerMobile: customerMobile,
        name: name,
        address: address,
        time: receivedAt ? new Date(Number(receivedAt)).toISOString() : null
      };

      await db.collection("surveyor_complete").insertOne(adminCompletePayload);
      console.log(`✅ Completion tracked locally in surveyor_complete collection for surveyor: ${surveyorNumber}`);

      return c.json({ success: true, message: "Order completion cataloged locally." });
    });
  } catch (err) {
    console.error("❌ Completion Exception Error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getAdminRejections = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const rejections = await db.collection("surveyor_reject").find({}).sort({ time: -1 }).toArray();
      return c.json({ success: true, count: rejections.length, data: rejections }, 200);
    });
  } catch (err) {
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getAdminCompletions = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const completions = await db.collection("surveyor_complete").find({}).sort({ time: -1 }).toArray();
      return c.json({ success: true, count: completions.length, data: completions }, 200);
    });
  } catch (err) {
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const updateSurveyStatus = async (c) => {
  try {
    const body = await c.req.json();
    const { id, status } = body;

    // 1. Parameter Validation
    if (!id || !status) {
      return c.json({ error: "Validation Error: Missing required fields 'id' or 'status'." }, 400);
    }

    // Standardize input string for robust comparison matching
    const normalizedStatus = status.toLowerCase().trim().replace(/[\s_]+/g, '-');

    // 2. Exact Mapping to Zoho's case-sensitive dropdown configurations
    let zohoValue = null;
    let localCleanedStatus = null;

    if (normalizedStatus === "scheduled") {
      zohoValue = "Scheduled";
      localCleanedStatus = "scheduled";
    } else if (normalizedStatus === "rejected") {
      zohoValue = "Rejected";
      localCleanedStatus = "rejected";
    } else if (normalizedStatus === "completed") {
      zohoValue = "Completed";
      localCleanedStatus = "completed";
    } else if (normalizedStatus === "accepted") {
      zohoValue = "Accepted";
      localCleanedStatus = "accepted";
    } else if (normalizedStatus === "inprogress" || normalizedStatus === "in-progress") {
      zohoValue = "In-Progress";
      localCleanedStatus = "inprogress"; // 🎯 Stripped down version for your frontend filter schema matrix
    }

    // Fallback if the requested value doesn't match your system options
    if (!zohoValue) {
      return c.json({
        error: `Validation Error: '${status}' is not recognized. Must be one of: scheduled, rejected, completed, accepted, inprogress`
      }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 🔐 Grab active authorization credentials dynamically out of your RAM/Atlas cache
      const zohoToken = await getZohoAccessToken(db);

      // 3. Build the precise Zoho payload using the perfectly formatted zohoValue
      const zohoPayload = {
        data: [
          {
            id: String(id),
            Site_Survey_Status: zohoValue
          }
        ]
      };

      console.log(`📡 Transmitting Targeted Dropdown Update to Zoho CRM Deals for record ID: ${id} -> Value: ${zohoValue}...`);

      // 4. Update Remote Zoho CRM
      const response = await fetch(`https://www.zohoapis.in/crm/v8/Deals/${id}`, {
        method: "PUT",
        headers: {
          "Authorization": `Zoho-oauthtoken ${zohoToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(zohoPayload)
      });

      if (!response.ok) {
        const errTxt = await response.text();
        console.error("❌ Zoho Dropdown Update execution failed:", errTxt);
        return c.json({ error: "Failed to update record state on Zoho.", details: errTxt }, 500);
      }

      const result = await response.json();
      console.log("✅ Zoho Server Response Status Payload:", JSON.stringify(result));

      // 5. 🔄 UNIFIED STEP: Sync straight to local MongoDB "deals" collection in the same loop
      console.log(`🔄 Syncing local status for Deal [${id}] to matching state: ${localCleanedStatus}`);

      const localResult = await db.collection("deals").updateOne(
        { deal_id: String(id) }, // Targets your primary deal ID cross reference string
        {
          $set: {
            siteSurveyStatus: localCleanedStatus,
            updatedAt: new Date().toISOString()
          }
        }
      );

      if (localResult.matchedCount === 0) {
        console.warn(`⚠️ Remote Zoho target updated, but no matching local record tracked for Deal ID: ${id}`);
      } else {
        console.log(`✅ Successfully shifted status locally for Deal [${id}] to pipeline flag: ${localCleanedStatus}`);
      }

      return c.json({
        success: true,
        message: `Site Survey Status successfully transitioned to '${zohoValue}' inside both Zoho and local database tracking.`,
        id: id,
        currentLocalStatus: localCleanedStatus
      });
    });

  } catch (err) {
    console.error("❌ Dropdown Update Exception Error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getOrders = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      // 🔐 Grab active authorization credentials dynamically out of RAM / config collection
      const zohoToken = await getZohoAccessToken(db);

      // 🏷️ Requesting all necessary Deal layout parameters from Zoho CRM
      const fieldsParam = "id,Deal_Name,Contact_Name,Mobile,WhatsApp_Number,Email,Stage,Description,Wattage_Required,Created_Time,Site_Survey_Status," +
        "Address_City,Address_Street_Address,Address_Coordinates_Latitude,Address_Coordinates_Longitude," +
        "City,Street_Address,Latitude,Longitude";

      console.log("📡 Admin Dashboard: Fetching active records from Zoho Deals engine...");

      const response = await fetch(`https://www.zohoapis.in/crm/v8/Deals?fields=${fieldsParam}&per_page=50`, {
        method: "GET",
        headers: {
          "Authorization": `Zoho-oauthtoken ${zohoToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        const errTxt = await response.text();
        console.error("❌ Zoho Fetch Deals failed for Admin:", errTxt);
        return c.json({ error: "Failed to retrieve records from Zoho Deals module." }, 500);
      }

      const result = await response.json();

      // Remap Zoho API Deal fields to clean, standardized JSON keys for your Admin Mobile UI
      const orders = (result.data || []).map(deal => {
        const rawStatus = deal.Site_Survey_Status || "";
        const cleanedSurveyStatus = rawStatus.toLowerCase().replace('-', '').trim();

        return {
          id: deal.id,
          name: deal.Deal_Name || (deal.Contact_Name ? deal.Contact_Name.name : "Unknown Customer"),
          mobile: deal.Mobile || deal.Contact_Number || null,
          whatsappNo: deal.WhatsApp_Number || null,
          email: deal.Email || null,

          // Dual Fallback Mapping logic matching your current CRM setup layouts
          city: deal.Address_City || deal.City || null,
          address: deal.Address_Street_Address || deal.Street_Address || null,
          latitude: deal.Address_Coordinates_Latitude || deal.Latitude || null,
          longitude: deal.Address_Coordinates_Longitude || deal.Longitude || null,

          comment: deal.Description || "",
          siteSurveyStatus: cleanedSurveyStatus || "accepted",

          // Extract the profile creation timestamp cleanly
          date: deal.Created_Time || null
        };
      });

      return c.json(orders);
    });
  } catch (err) {
    console.error("❌ GetOrders (Deals Mapping) Error Exception:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteOrder = async (c) => {
  try {
    const body = await c.req.json();

    // 🛑 Strict Business Rule: Explicit Zoho 'id' string is mandatory to target the precise deal
    if (!body.id) {
      return c.json({ error: "Validation Error: A specific Zoho 'id' field is required to delete an order." }, 400);
    }

    const targetZohoId = body.id;

    return await withDatabase(MONGODB_URI, async (db) => {
      // 🔐 Grab active authorization credentials dynamically
      const zohoToken = await getZohoAccessToken(db);

      console.log(`🗑️ Initializing targeted erasure from Zoho CRM for Deal ID: ${targetZohoId}`);

      // 1. Send the HTTP DELETE request straight to Zoho's explicit DEALS endpoint
      const response = await fetch(`https://www.zohoapis.in/crm/v8/Deals/${targetZohoId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Zoho-oauthtoken ${zohoToken}`
        }
      });

      if (!response.ok) {
        const errDetails = await response.text();
        console.error("❌ Zoho Deletion Blocked:", errDetails);
        return c.json({ error: "Zoho CRM deletion operation failed.", details: errDetails }, 500);
      }

      console.log(`✅ Successfully deleted deal with ID: ${targetZohoId} from Zoho CRM.`);

      // 2. 🧹 LOCAL CLEANUP: Also remove the assignment tracking record from your local MongoDB
      const dbCleanup = await db.collection("deals").deleteOne({ deal_id: targetZohoId });

      if (dbCleanup.deletedCount > 0) {
        console.log(`🧹 Local DB Cleanup: Removed deal ${targetZohoId} from local 'deals' collection.`);
      } else {
        console.log(`ℹ️ Local DB Cleanup: No local assignment document found for deal ${targetZohoId}.`);
      }

      return c.json({
        success: true,
        message: "Deal record deleted successfully from Zoho CRM and local tracking.",
        id: targetZohoId
      }, 200);
    });
  } catch (err) {
    console.error("❌ DeleteOrder Error Exception:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const handleZohoDealWebhook = async (c) => {
  try {
    let payload = {};

    // 1. Grab any URL query string parameters (e.g., ?deal_id=123)
    const queryParams = c.req.query();
    if (Object.keys(queryParams).length > 0) {
      payload = { ...payload, ...queryParams };
    }

    // 2. Read the raw text body to handle direct streams safely
    const rawText = await c.req.text();

    if (rawText && rawText.trim().length > 0) {
      try {
        // Check if it's a pure JSON string
        const parsedJson = JSON.parse(rawText);
        payload = { ...payload, ...parsedJson };
      } catch {
        // If it's a form-encoded string (key1=val1&key2=val2)
        const searchParams = new URLSearchParams(rawText);
        const formObj = Object.fromEntries(searchParams.entries());
        payload = { ...payload, ...formObj };
      }
    }

    // Execute database operations safely using your wrapper
    return await withDatabase(MONGODB_URI, async (db) => {

      // 1. Query for all users whose role is admin
      const admins = await db.collection("userDetails")
        .find({ "UserInfo.role": "admin" })
        .toArray();

      console.log(`🔍 DB Check: Found ${admins.length} matching admin documents.`);

      // 2. Safely collect all active fcmTokens into a clean array
      let fcmTokens = [];
      admins.forEach((adminUser, idx) => {
        console.log(`👤 Processing Admin [${idx}]: Phone: ${adminUser.UserInfo?.phoneNo || "N/A"}`);

        const devices = adminUser.PlatformInfo?.devices;
        if (devices && Array.isArray(devices)) {
          console.log(`📱 Found ${devices.length} devices mapped for this admin.`);
          devices.forEach((device, dIdx) => {
            console.log(`   👉 Device [${dIdx}] Token State:`, device.fcmToken ? "Token Available" : "Token is EMPTY/MISSING");
            if (device.fcmToken) {
              fcmTokens.push(device.fcmToken);
            }
          });
        } else {
          console.log(`⚠️ Admin [${idx}] has no active 'PlatformInfo.devices' array structure.`);
        }
      });

      console.log("📊 Total Collected Admin Tokens Array Count:", fcmTokens.length);

      // 3. Fire notifications if any admin devices were tracked down
      if (fcmTokens.length > 0) {
        const message = {
          notification: {
            title: "New Deal Created! 🚀",
            body: `Deal: ${payload.deal_name || "New Opportunity"} is now in ${payload.stage || "Qualification"}.`,
          },
          // 🤖 Force High Priority and Channel Mapping for Android Default Sound
          android: {
            priority: "high",
            notification: {
              channelId: "weekly_summary_channel_v1", // 👈 Tells Android to use your high-importance channel rules
              sound: "default",
            }
          },
          // 🍏 Standard iOS Default Sound Setup
          apns: {
            payload: {
              aps: {
                sound: "default"
              }
            }
          },
          data: {
            deal_id: payload.deal_id || "",
          },
          tokens: fcmTokens,
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`✅ Push notifications dispatched successfully to ${response.successCount} admin devices.`);
      } else {
        console.log("⚠️ No active admin FCM tokens found in the database.");
      }

      return c.json({ success: true, message: "Captured and notifications processed" }, 200);
    });

  } catch (err) {
    console.error("❌ Webhook Processing Error Exception:", err.message);
    return c.json({ error: "Failed to process deal webhook pipeline" }, 500);
  }
};


export const assignDealToSurveyor = async (c) => {
  try {
    const body = await c.req.json();

    const {
      id,
      name,
      mobile,
      whatsappNo,
      email,
      city,
      address,
      latitude,
      longitude,
      comment,
      date,
      surveyorNumber: rawSurveyorNumber
    } = body;

    if (!id || !rawSurveyorNumber || !mobile) {
      return c.json({ error: "Missing required fields: id (deal_id), surveyorNumber, or mobile" }, 400);
    }

    // 🧼 CLEAN PHONE NUMBERS (Strips formatting symbols and drops leading country codes)
    let surveyorNumber = String(rawSurveyorNumber).replace(/\D/g, '');
    if (surveyorNumber.length === 12 && surveyorNumber.startsWith('91')) {
      surveyorNumber = surveyorNumber.substring(2);
    }

    let cleanMobile = mobile ? String(mobile).replace(/\D/g, '') : null;
    if (cleanMobile && cleanMobile.length === 12 && cleanMobile.startsWith('91')) {
      cleanMobile = cleanMobile.substring(2);
    }

    let cleanWhatsappNo = whatsappNo ? String(whatsappNo).replace(/\D/g, '') : null;
    if (cleanWhatsappNo && cleanWhatsappNo.length === 12 && cleanWhatsappNo.startsWith('91')) {
      cleanWhatsappNo = cleanWhatsappNo.substring(2);
    }

    return await withDatabase(MONGODB_URI, async (db) => {

      const fullDealPayload = {
        deal_id: id,
        deal_name: name || "New Site Opportunity",
        mobile: cleanMobile,
        whatsappNo: cleanWhatsappNo,
        email: email || null,
        city: city || null,
        address: address || null,
        latitude: latitude || null,
        longitude: longitude || null,
        comment: comment || "",
        siteSurveyStatus: "notassigned",
        date: date || null,
        assignedTo: surveyorNumber,
        assignedAt: new Date().toISOString(),
      };

      await db.collection("deals").updateOne(
        { deal_id: id },
        { $set: fullDealPayload },
        { upsert: true }
      );

      console.log(`🎯 Complete Deal payload for [${id}] successfully mapped to surveyor: ${surveyorNumber}`);

      const surveyorProfile = await db.collection("userDetails").findOne({
        "UserInfo.phoneNo": surveyorNumber,
        "UserInfo.role": "surveyor"
      });

      if (!surveyorProfile) {
        console.log(`⚠️ Assignment saved, but surveyor profile not found for number: ${surveyorNumber}`);
        return c.json({ success: true, message: "Deal assigned locally, but surveyor profile missing." }, 200);
      }

      let surveyorTokens = [];
      const devices = surveyorProfile.PlatformInfo?.devices || [];

      // ⚡ TOKEN OPTIMIZATION: Try to find the active logged-in device session first
      const activeDevice = devices.find(d => d.isLastLoggedIn === true && d.fcmToken);

      if (activeDevice) {
        surveyorTokens.push(activeDevice.fcmToken);
      } else {
        // Fallback: Collect all available tokens as a backup safety net
        devices.forEach((device) => {
          if (device.fcmToken) surveyorTokens.push(device.fcmToken);
        });
      }

      if (surveyorTokens.length > 0) {
        // Fixed the trailing syntax brace typo here from your template layout context
        const structuredBody = `👤 Name : ${name || 'N/A'}\n📍 Address : ${address || 'N/A'}`;

        const message = {
          notification: {
            title: "🔔 New Lead Nearby!",
            body: structuredBody,
          },
          android: {
            priority: "high",
            notification: {
              channelId: "custom_sound_channel_v2",
              sound: "kondaas",
              clickAction: "FLUTTER_NOTIFICATION_CLICK",
            },
            fcmOptions: {
              analyticsLabel: "lead_assignment"
            }
          },
          apns: {
            payload: {
              aps: {
                sound: "kondaas.caf",
                contentAvailable: true,
                alert: {
                  title: "🔔 New Lead Nearby!",
                  body: structuredBody,
                  launchImage: ""
                }
              }
            }
          },
          data: {
            deal_id: String(id),
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            type: "ASSIGNMENT",
            customer_name: name || "",
            customer_mobile: cleanMobile || "",      // Clean parameter mapped to data object
            customer_address: address || "",
            leadId: String(id),
            customerMobile: cleanMobile || "",      // Clean parameter mapped to data object
            customerName: name || "",
            address: address || "",
          },
          tokens: surveyorTokens,
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`🚀 Notification sent to surveyor (${surveyorNumber}). Success count: ${response.successCount}`);
      } else {
        console.log(`⚠️ Surveyor found, but no active FCM tokens registered for phone: ${surveyorNumber}`);
      }

      return c.json({ success: true, message: "Deal successfully assigned and surveyor notified with clean parameters." }, 200);
    });

  } catch (err) {
    console.error("❌ Assignment Endpoint Error:", err.message);
    return c.json({ error: "Internal server error during assignment pipeline" }, 500);
  }
};

export const zohoWorkflowAssignment = async (c) => {
  try {
    const urlQueries = c.req.query() || {};
    let rawText = "";

    try {
      rawText = await c.req.text();
    } catch (e) { }

    let bodyParams = {};
    if (rawText && rawText.trim().length > 0) {
      try {
        bodyParams = Object.fromEntries(new URLSearchParams(rawText.trim()));
      } catch (e) { }
    }

    const payload = { ...bodyParams, ...urlQueries };

    const id = payload.deal_id || payload.id;
    const name = payload.deal_name || payload.name;
    const email = payload.Email || payload.customer_email || null;
    const city = payload.city || null;
    const state = payload.state || null;
    const street = payload.Street || null;
    const latitude = payload.latitude || null;
    const longitude = payload.longitude || null;
    const referred_by = payload.referred_by || null;
    const Site_Survey_Req_Date_Time = payload.Site_Survey_Req_Date_Time || null;
    const comment = payload.comment || "Assigned via Zoho CRM Automated Field Update";
    const Service_Agent_Name = payload.Service_Agent_Name || null;
    const home_location = payload.home_location || null;
    const office_location = payload.office_location || null;

    // ⚡ SMART PARSING WORKAROUND FOR COMBINED ZOHO FIELD:
    let CreatedBy = null;
    let District = null;
    let SubDistrict = null;
    let GoogleLocation = null;
    let leadSource = null;
    let postalCode = null;
    let country = null;
    let No_of_Panels = null;
    let roofType = null;


    const rawCreatedBy = payload.Created_By || null;

    if (rawCreatedBy) {
      if (rawCreatedBy.includes('&')) {
        // Prepend 'CreatedBy=' so standard URLSearchParams can parse all sub-parameters seamlessly
        const parsedParams = new URLSearchParams(`CreatedBy=${rawCreatedBy.trim()}`);

        CreatedBy = parsedParams.get('CreatedBy')?.trim() || null;
        No_of_Panels = parsedParams.get('No_of_Panels')?.trim() || null;
        roofType = parsedParams.get('Roof_Type')?.trim() || null;
        District = parsedParams.get('District')?.trim() || null;
        SubDistrict = parsedParams.get('Sub_District')?.trim() || null;
        GoogleLocation = parsedParams.get('Google_Location')?.trim() || null;
        postalCode = parsedParams.get('postal_code')?.trim() || null;
        country = parsedParams.get('country')?.trim() || null;
        leadSource = parsedParams.get('lead_Source')?.trim() || parsedParams.get('leadSource')?.trim() || null;
      } else {
        // Fallback case if Zoho sends un-bundled standard text
        CreatedBy = rawCreatedBy.trim();
        District = payload.District?.trim() || null; 
        SubDistrict = payload.Sub_District?.trim() || null;
        GoogleLocation = payload.Google_Location?.trim() || null;
        postalCode = payload.postal_code?.trim() || null;
        country = payload.country?.trim() || null;
        leadSource = payload.lead_Source?.trim() || payload.leadSource?.trim() || null;
      }
    } else {
      // Direct payload fallback if Created_By is missing entirely
      leadSource = payload.lead_Source?.trim() || payload.leadSource?.trim() || null;
    }

    const productType = payload.Product_Type || null;
    const orderType = payload.Order_Type || null;
    const projectType = payload.Project_Type || null;
    const projectModel = payload.Project_Model || null;
    const inverterConnectionType = payload.Inverter_Connection_Type || null;
    const inverterCapacity = payload.Inverter_Capacity || null;
    const solarPanel_Model = payload.Solar_Panel_Model || null;
    const solarPanelBrand = payload.Solar_Panel_Brand || null;
   

    const siteEngineerContact = payload.site_engineer_contact || payload.Site_Engineer_Contact;

    if (!id || !siteEngineerContact) {
      return c.json({ error: "Missing required fields: id or site_engineer_contact from Zoho payload" }, 400);
    }

    // 🧼 Clean and strip phone formatting symbols from surveyor/engineer contact
    let surveyorNumber = String(siteEngineerContact).replace(/\D/g, '');
    if (surveyorNumber.length === 12 && surveyorNumber.startsWith('91')) {
      surveyorNumber = surveyorNumber.substring(2);
    }

    // 🧼 CLEAN CUSTOMER PHONE NUMBERS BEFORE DB STORAGE AND FCM DELIVERY
    let cleanMobile = payload.mobile ? String(payload.mobile).replace(/\D/g, '') : null;
    if (cleanMobile && cleanMobile.length === 12 && cleanMobile.startsWith('91')) {
      cleanMobile = cleanMobile.substring(2);
    }

    let cleanWhatsappNo = payload.whatsappNo || payload.customer_whatsapp || null;
    if (cleanWhatsappNo) {
      cleanWhatsappNo = String(cleanWhatsappNo).replace(/\D/g, '');
      if (cleanWhatsappNo.length === 12 && cleanWhatsappNo.startsWith('91')) {
        cleanWhatsappNo = cleanWhatsappNo.substring(2);
      }
    }

    return await withDatabase(MONGODB_URI, async (db) => {

      const fullDealPayload = {
        deal_id: id,
        deal_name: name || "New Site Opportunity",
        mobile: cleanMobile,
        whatsappNo: cleanWhatsappNo,
        email: email,
        city: city,
        street: street,
        latitude: latitude,
        longitude: longitude,
        comment: comment,
        referred_by: referred_by,
        Site_Survey_Req_Date_Time: Site_Survey_Req_Date_Time,
        siteSurveyStatus: "notassigned",
        assignedTo: surveyorNumber,
        assignedAt: new Date().toISOString(),
        leadSource: leadSource,
        state: state,
        postalCode: postalCode,
        country: country,
        CreatedBy: CreatedBy,
        District: District,
        ServiceAgentName: Service_Agent_Name,
        SubDistrict: SubDistrict,
        GoogleLocation: GoogleLocation,
        home_location: home_location,
        office_location: office_location,

        productType: productType,
        orderType: orderType,
        projectType: projectType,
        projectModel: projectModel,
        inverterConnectionType: inverterConnectionType,
        inverterCapacity: inverterCapacity,
        solarPanelModel: solarPanel_Model,
        solarPanelBrand: solarPanelBrand,
        noOfPanels: No_of_Panels,
        roofType: roofType,
      };

      await db.collection("deals").updateOne(
        { deal_id: id },
        { $set: fullDealPayload },
        { upsert: true }
      );

      console.log(`🎯 Zoho Assignment Sync -> Deal: ${id} mapped to Surveyor: ${surveyorNumber}`);

      const surveyorProfile = await db.collection("userDetails").findOne({
        "UserInfo.phoneNo": surveyorNumber,
        "UserInfo.role": "surveyor"
      });

      if (!surveyorProfile) {
        console.log(`⚠️ Surveyor profile missing from database for number: ${surveyorNumber}`);
        return c.json({ success: true, message: "Deal assignment locally, but surveyor profile missing." }, 200);
      }

      let surveyorTokens = [];
      const devices = surveyorProfile.PlatformInfo?.devices || [];

      // ⚡ TOKEN OPTIMIZATION: Isolate the single active device layout session
      const activeDevice = devices.find(d => d.isLastLoggedIn === true && d.fcmToken);

      if (activeDevice) {
        surveyorTokens.push(activeDevice.fcmToken);
      } else {
        // Fallback safety net
        devices.forEach((device) => {
          if (device.fcmToken) surveyorTokens.push(device.fcmToken);
        });
      }

      if (surveyorTokens.length > 0) {
        const structuredBody = `👤 Name : ${name || 'N/A'}\n📍 Address : ${street || 'N/A'}`;

        const message = {
          notification: {
            title: "🔔 New Lead Nearby!",
            body: structuredBody,
          },
          android: {
            priority: "high",
            notification: {
              channelId: "custom_sound_channel_v2",
              sound: "kondaas",
              clickAction: "FLUTTER_NOTIFICATION_CLICK",
            },
            fcmOptions: {
              analyticsLabel: "lead_assignment"
            }
          },
          apns: {
            payload: {
              aps: {
                sound: "kondaas.caf",
                contentAvailable: true,
                alert: {
                  title: "🔔 New Lead Nearby!",
                  body: structuredBody,
                  launchImage: ""
                }
              }
            }
          },
          data: {
            deal_id: String(id),
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            type: "ASSIGNMENT",
            customer_name: name || "",
            customer_mobile: cleanMobile || "",
            customer_address: street || "",
            leadId: String(id),
            customerMobile: cleanMobile || "",
            customerName: name || "",
            address: street || "",
          },
          tokens: surveyorTokens,
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`🚀 Dispatch Notification -> Sent to: ${surveyorNumber} (Success count: ${response.successCount})`);
      } else {
        console.log(`⚠️ No active FCM device tokens registered for surveyor: ${surveyorNumber}`);
      }

      return c.json({ success: true, message: "Deal assignment complete and surveyor notified smoothly." }, 200);
    });

  } catch (err) {
    console.error("❌ Zoho Assignment Webhook Error:", err.message);
    return c.json({ error: "Internal server error during Zoho assignment pipeline" }, 500);
  }
};


export const getSurveyorDeals = async (c) => {
  try {
    // Grab the logged-in surveyor's mobile number sent from their app
    const { surveyorNumber } = c.req.query();

    if (!surveyorNumber) {
      return c.json({ error: "Missing surveyor identity verification parameter" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {

      // Query the deals collection looking strictly for matches against their phone number
      const assignedDeals = await db.collection("deals")
        .find({ assignedTo: surveyorNumber })
        .sort({ assignedAt: -1 }) // Sort so newest jobs pop up first
        .toArray();

      console.log(`📱 Surveyor Workspace [${surveyorNumber}] loaded. Sent back ${assignedDeals.length} detailed tasks.`);

      // Send the entire structure back exactly how the UI models expect it
      return c.json({ success: true, deals: assignedDeals }, 200);
    });

  } catch (err) {
    console.error("❌ Fetch Surveyor Dashboard Exception:", err.message);
    return c.json({ error: "Failed to pull surveyor task workspace" }, 500);
  }
};