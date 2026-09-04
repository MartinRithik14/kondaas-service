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
    // 1. Extract query params string (e.g. ?deal_id=123&state=TamilNadu)
    const url = new URL(c.req.url);
    const queryString = url.search; // includes the leading '?' if present

    // 2. Extract raw body text and headers
    const rawBody = await c.req.text().catch(() => "");
    const contentType = c.req.header("content-type") || "application/x-www-form-urlencoded";

    // 3. Target AWS machine endpoint with query string attached
    const targetUrl = `https://board.trisentrix.com/order/webhook${queryString}`;

    const options = {
      method: c.req.method,
      headers: {
        "Content-Type": contentType,
      },
    };

    if (rawBody && ["POST", "PUT", "PATCH"].includes(c.req.method.toUpperCase())) {
      options.body = rawBody;
    }

    // 4. Forward to AWS instance
    const awsResponse = await fetch(targetUrl, options);

    // 5. Safely parse response back to caller
    const responseText = await awsResponse.text();
    try {
      const responseData = JSON.parse(responseText);
      return c.json(responseData, awsResponse.status);
    } catch {
      return c.text(responseText, awsResponse.status);
    }
  } catch (err) {
    console.error("❌ Zoho Assignment Proxy Error:", err.message);
    return c.json({ error: `Proxy failure: ${err.message}` }, 500);
  }
};


export const assignDealToSurveyor = async (c) => {
 try {
    // 1. Extract query params string (e.g. ?deal_id=123&state=TamilNadu)
    const url = new URL(c.req.url);
    const queryString = url.search; // includes the leading '?' if present

    // 2. Extract raw body text and headers
    const rawBody = await c.req.text().catch(() => "");
    const contentType = c.req.header("content-type") || "application/x-www-form-urlencoded";

    // 3. Target AWS machine endpoint with query string attached
    const targetUrl = `https://board.trisentrix.com/order/assign${queryString}`;

    const options = {
      method: c.req.method,
      headers: {
        "Content-Type": contentType,
      },
    };

    if (rawBody && ["POST", "PUT", "PATCH"].includes(c.req.method.toUpperCase())) {
      options.body = rawBody;
    }

    // 4. Forward to AWS instance
    const awsResponse = await fetch(targetUrl, options);

    // 5. Safely parse response back to caller
    const responseText = await awsResponse.text();
    try {
      const responseData = JSON.parse(responseText);
      return c.json(responseData, awsResponse.status);
    } catch {
      return c.text(responseText, awsResponse.status);
    }
  } catch (err) {
    console.error("❌ Zoho Assignment Proxy Error:", err.message);
    return c.json({ error: `Proxy failure: ${err.message}` }, 500);
  }
};

export const zohoWorkflowAssignment = async (c) => {
  try {
    const url = new URL(c.req.url);
    const queryString = url.search;
    const rawBody = await c.req.text().catch(() => "");
    const contentType = c.req.header("content-type") || "application/x-www-form-urlencoded";

    const targetUrl = `https://board.trisentrix.com/order/zoho-assign${queryString}`;

    const options = {
      method: c.req.method,
      headers: {
        "Content-Type": contentType,
      },
    };

    if (rawBody && ["POST", "PUT", "PATCH"].includes(c.req.method.toUpperCase())) {
      options.body = rawBody;
    }

    const awsResponse = await fetch(targetUrl, options);
    const responseText = await awsResponse.text();

    try {
      const responseData = JSON.parse(responseText);
      return c.json(responseData, awsResponse.status);
    } catch {
      return c.text(responseText || "OK", awsResponse.status);
    }
  } catch (err) {
    console.error("❌ Zoho Assignment Proxy Error:", err.message);
    return c.json({ error: `Proxy failure: ${err.message}` }, 500);
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