import { withDatabase } from '../utils/config.js'; 
import fs from 'fs';
import path from 'path';
import { getZohoAccessToken } from '../utils/zohoAuth.js';
import { uploadToZohoWorkDrive, getOrCreateLeadsSEFolder } from '../utils/uploadToZohoWorkDrive.js';

const MONGODB_URI = process.env.MONGODB_URI;

const parseTime = (timeStr) => {
  const [time, modifier] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (modifier === 'PM' && hours !== 12) hours += 12;
  if (modifier === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
};

const epochToDateTime = (epoch) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(epoch + IST_OFFSET);
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  const date = `${year}${month}${day}`;

  let hours = istDate.getUTCHours();
  const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
  const modifier = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const time = `${String(hours).padStart(2, '0')}:${minutes} ${modifier}`;

  return { date, time };
};

export const addLocation = async (c) => {
  try {
    const { phoneNo, latitude, longitude, epoch } = await c.req.json();
    if (!phoneNo || !latitude || !longitude || !epoch) {
      return c.json({ error: "Required fields missing!" }, 400);
    }

    const { date, time } = epochToDateTime(epoch);
    const newEntry = { time, latitude, longitude, isLatest: true };

    return await withDatabase(MONGODB_URI, async (db) => {
      const doc = await db.collection("logistic-location").findOne({ phoneNo });

      if (!doc || !doc[date]) {
        // Handle first entry of the day
        await db.collection("logistic-location").updateOne(
          { phoneNo },
          { $push: { [date]: newEntry } },
          { upsert: true }
        );
      } else {
        // Recalculate based on time-strings to handle network lag/out-of-order pings
        const entries = [...doc[date], newEntry];
        let latestTime = -1;
        let latestIndex = -1;

        entries.forEach((entry, index) => {
          const entryTime = parseTime(entry.time);
          if (entryTime >= latestTime) {
            latestTime = entryTime;
            latestIndex = index;
          }
        });

        const updatedEntries = entries.map((entry, index) => ({
          ...entry,
          isLatest: index === latestIndex
        }));

        await db.collection("logistic-location").updateOne(
          { phoneNo },
          { $set: { [date]: updatedEntries } }
        );
      }
      return c.json({ message: "Location saved successfully!" });
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};

export const getLocationByTime = async (c) => {
  try {
    const { mobiles, date, startTime, endTime } = await c.req.json();
    if (!mobiles || !date || !startTime || !endTime) return c.json({ error: "Missing fields" }, 400);

    const start = parseTime(startTime);
    const end = parseTime(endTime);

    return await withDatabase(MONGODB_URI, async (db) => {
      const docs = await db.collection("logistic-location").find({ phoneNo: { $in: mobiles } }).toArray();
      const result = docs.map((doc) => {
        const entries = doc[date] || [];
        const filtered = entries.filter((entry) => {
          const entryTime = parseTime(entry.time);
          return entryTime >= start && entryTime <= end;
        });
        return { phoneNo: doc.phoneNo, entries: filtered };
      });
      return c.json(result);
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};

export const getCurrentLocation = async (c) => {
  try {
    const { mobiles } = await c.req.json();
    if (!mobiles) return c.json({ error: "mobiles is required!" }, 400);

    const { date } = epochToDateTime(Date.now());

    return await withDatabase(MONGODB_URI, async (db) => {
      const docs = await db.collection("logistic-location").find({ phoneNo: { $in: mobiles } }).toArray();
      const result = docs.map((doc) => {
        const entries = doc[date] || [];
        const latest = entries.find((entry) => entry.isLatest === true);
        return { phoneNo: doc.phoneNo, currentLocation: latest || null };
      });
      return c.json(result);
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};

export const getLogisticsDealsByMobile = async (c) => {
  try {
    // 1. Grab the mobile number from the query string parameters (e.g., ?mobile=6666666666)
    const mobile = c.req.query("mobile");

    if (!mobile) {
      return c.json({ success: false, error: "Missing mobile query parameter" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 2. Fetch all assignments matching this mobile number
      const deals = await db
        .collection("logistics_deals")
        .find({ mobile: mobile })
        .sort({ assignedAt: -1 }) // ✨ Newest runs appear at the top of their screen
        .toArray();

      // 3. Return the array to populate the app's list view
      return c.json({
        success: true,
        count: deals.length,
        data: deals
      }, 200);
    });

  } catch (err) {
    console.error("❌ Fetching Logistics Deals Exception:", err.message);
    return c.json({ success: false, error: "Failed to retrieve logistics assignments" }, 500);
  }
};

export const updateLogisticsStatus = async (c) => {
  try {
    const body = await c.req.json();
    const { deal_id, status } = body;

    // 1. Core validation guard clause
    if (!deal_id || !status) {
      return c.json({ success: false, error: "Missing deal_id or status in request body" }, 400);
    }

    // 2. Strict white-list status validation to protect data integrity
    const allowedStatuses = ["accepted", "inprogress", "completed"];
    if (!allowedStatuses.includes(status)) {
      return c.json({ 
        success: false, 
        error: `Invalid status. Must be one of: ${allowedStatuses.join(", ")}` 
      }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 3. Update the status and append a trailing audit timestamp
      const updateResult = await db.collection("logistics_deals").updateOne(
        { deal_id: deal_id },
        { 
          $set: { 
            status: status,
            updatedAt: new Date()
          } 
        }
      );

      // 4. Verify that the deal profile actually exists
      if (updateResult.matchedCount === 0) {
        return c.json({ success: false, error: "No logistics record found matching that deal_id" }, 404);
      }

      console.log(`⚡ Logistics Deal ${deal_id} status updated to: ${status.toUpperCase()}`);

      return c.json({ 
        success: true, 
        message: `Logistics pipeline successfully moved to ${status}.` 
      }, 200);
    });

  } catch (err) {
    console.error("❌ updateLogisticsStatus Exception Error:", err.message);
    return c.json({ success: false, error: "Internal Server Error updating logistics state" }, 500);
  }
};

export const rejectLogisticsDeal = async (c) => {
  try {
    const body = await c.req.json();
    // 1. Destructure only the relevant logistics parameters
    const { deal_id, mobile, comment } = body;

    if (!deal_id || !comment) {
      return c.json({ success: false, error: "deal_id and rejection reason (comment) are required" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 2. Insert lightweight audit document into 'logistics_rejects'
      const rejectPayload = {
        deal_id: String(deal_id),
        mobile: mobile || "N/A",
        comment: comment,
        rejectedAt: new Date()
      };

      await db.collection("logistics_reject").insertOne(rejectPayload);
      console.log(`✅ Rejection tracked in logistics_reject for driver: ${mobile}`);

     

      // 4. Look up active Administrator accounts to fetch their FCM tokens
      try {
        const admins = await db.collection("userdetails").find({
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

        // 5. Send standard push notification to Admins
        if (adminTokens.length > 0) {
          const message = {
            notification: {
              title: "🚨 Delivery Assignment Rejected!",
              body: `Logistics member (${mobile || 'Driver'}) rejected Deal ID: ${deal_id}. Reason: ${comment}`,
            },
            android: {
              priority: "high",
              notification: {
                channelId: "weekly_summary_channel_v1",
                sound: "default",
              }
            },
            apns: {
              payload: {
                aps: {
                  sound: "default"
                }
              }
            },
            data: {
              click_action: "FLUTTER_NOTIFICATION_CLICK",
              type: "LOGISTICS_REJECTION",
              deal_id: String(deal_id)
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

      return c.json({ success: true, message: "Logistics deal rejection tracked and Admin notified." }, 200);
    });
  } catch (err) {
    console.error("❌ rejectLogisticsDeal Exception Error:", err.message);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
};


export const createLogisticsProduct = async (c) => {
  try {
    const body = await c.req.json();

    // 1. Basic Payload Validation
    if (!body || Object.keys(body).length === 0) {
      return c.json({ 
        error: "Validation Error: Request body is empty. No data received." 
      }, 400);
    }

    // 2. Persist to MongoDB Atlas
    return await withDatabase(MONGODB_URI, async (db) => {
      const collection = db.collection("kondaas-products");

      // 🚀 THE MAGIC DUMP: Accepts whatever comes here as it is
      const newLogisticsRecord = {
        ...body,
        createdAt: new Date(), // Record tracking timestamp
        status: "picked" 
      };

      console.log(`📦 Storing dynamic product details into kondaas-products...`);
      
      const insertResult = await collection.insertOne(newLogisticsRecord);

      return c.json({
        success: true,
        message: "Logistics product and pricing records successfully stored.",
        recordId: insertResult.insertedId
      }, 201);
    });

  } catch (err) {
    console.error("❌ Logistics Product Capture Exception:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const updateProductStatus = async (c) => {
  try {
    const body = await c.req.json();
    const { id, status } = body;

    // 1. Basic validation
    if (!id || !status) {
      return c.json({ error: "Validation Error: Both 'id' and 'status' are required in the body." }, 400);
    }

    const allowedStatuses = [ "dropped", "received", "inprogress", "installed"];
    if (!allowedStatuses.includes(status)) {
      return c.json({ error: `Validation Error: Invalid status. Must be one of: ${allowedStatuses.join(', ')}` }, 400);
    }

    // 2. Update directly in MongoDB
    return await withDatabase(MONGODB_URI, async (db) => {
      const collection = db.collection("kondaas-products");
      const { ObjectId } = await import('mongodb');

      const updateResult = await collection.updateOne(
        { _id: new ObjectId(id) },
        { 
          $set: { 
            status: status
          } 
        }
      );

      if (updateResult.matchedCount === 0) {
        return c.json({ error: "Product record not found." }, 404);
      }

      console.log(`🔄 Product ${id} updated to status: ${status}`);

      return c.json({
        success: true,
        message: `Product status successfully updated to '${status}'.`
      }, 200);
    });

  } catch (err) {
    console.error("❌ Product Status Update Exception:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const logLogisticsCompletion = async (c) => {
  try {
    const body = await c.req.json();
    // 1. Extract only the identifying fields from the request body
    const { deal_id, mobile } = body;

    if (!deal_id || !mobile) {
      return c.json({ success: false, error: "Missing deal_id or mobile number" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 2. Insert a clean, lightweight entry into the completion log collection
      const completionPayload = {
        deal_id: String(deal_id),
        mobile: mobile,
        completedAt: new Date()
      };

      await db.collection("logistics_completed").insertOne(completionPayload);
      console.log(`✅ Completion log created for Deal ID: ${deal_id} by driver: ${mobile}`);

      // 3. Send back a clean success response to the app
      return c.json({ 
        success: true, 
        message: "Delivery completion successfully logged." 
      }, 200);
    });

  } catch (err) {
    console.error("❌ logLogisticsCompletion Exception Error:", err.message);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
};


export const handleDispatchWebhook = async (c) => {
  try {
    const payload = await c.req.json();

    // Basic validation
    if (!payload.dispatch_number) {
      return c.json({ error: "dispatch_number is required!" }, 400);
    }

    const dispatchDoc = {
      ...payload,
      assigned_to: payload.driver_mobile || payload.assigned_to || null,
      updatedAt: new Date(),
    };

    return await withDatabase(MONGODB_URI, async (db) => {
      const collection = db.collection("dispatches");

      // Upsert so re-triggers update existing dispatches instead of duplicating
      const result = await collection.updateOne(
        { dispatch_number: payload.dispatch_number },
        { 
          $set: dispatchDoc, 
          $setOnInsert: { createdAt: new Date() } 
        },
        { upsert: true }
      );

      return c.json({
        success: true,
        message: "Dispatch webhook processed successfully",
        matchedCount: result.matchedCount,
        upsertedId: result.upsertedId,
      }, 200);
    });

  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};


export const getMyDispatches = async (c) => {
  try {
    const driverMobile = c.req.query("driver_mobile") || c.req.query("assigned_to");

    if (!driverMobile) {
      return c.json({ error: "driver_mobile or assigned_to is required" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const collection = db.collection("dispatches");

      // Query by driver_mobile or assigned_to, sorted by newest first
      const dispatches = await collection
        .find({
          $or: [
            { driver_mobile: driverMobile },
            { assigned_to: driverMobile }
          ]
        })
        .sort({ createdAt: -1 })
        .toArray();

      return c.json({
        success: true,
        count: dispatches.length,
        data: dispatches,
      }, 200);
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};



// Zoho Creator Configuration
const CREATOR_ACCOUNT_OWNER = "kondaasautomation";
const CREATOR_APP_NAME = "packing-management";
const PACKAGES_REPORT_NAME = "Packages";
const DISPATCHES_REPORT_NAME = "Dispatches"; // Verify this exact report link name if updating parent dispatch in Creator

/**
 * Update record status in Zoho Creator v2 REST API
 */
async function updateCreatorRecord(reportLinkName, searchField, searchValue, updateData, zohoToken) {
  // 1. Search for Record ID
  const criteria = `${searchField}=="${searchValue}"`;
  const searchUrl = `https://creator.zoho.in/api/v2/${CREATOR_ACCOUNT_OWNER}/${CREATOR_APP_NAME}/report/${reportLinkName}?criteria=(${encodeURIComponent(criteria)})`;

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Zoho-oauthtoken ${zohoToken}` }
  });

  if (!searchRes.ok) {
    const errTxt = await searchRes.text();
    throw new Error(`Creator Search Failed (${reportLinkName}): ${errTxt}`);
  }

  const searchData = await searchRes.json();
  const recordId = searchData.data?.[0]?.ID;

  if (!recordId) {
    throw new Error(`Record not found in Creator [${reportLinkName}] for: ${searchValue}`);
  }

  // 2. Patch Record Status
  const updateUrl = `https://creator.zoho.in/api/v2/${CREATOR_ACCOUNT_OWNER}/${CREATOR_APP_NAME}/report/${reportLinkName}/${recordId}`;

  const updateRes = await fetch(updateUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Zoho-oauthtoken ${zohoToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: updateData })
  });

  if (!updateRes.ok) {
    const errTxt = await updateRes.text();
    throw new Error(`Creator Update Failed: ${errTxt}`);
  }

  return await updateRes.json();
}

export const updateDispatchOrPackageStatus = async (c) => {
  try {
    const body = await c.req.json();
    const { dispatch_number, package_number, status } = body;

    if (!dispatch_number || !status) {
      return c.json({ error: "Validation Error: Missing 'dispatch_number' or 'status'." }, 400);
    }

    const normalized = status.toLowerCase().trim().replace(/[\s_]+/g, '-');
    const isPackageUpdate = Boolean(package_number);

    let zohoValue = null;
    let localCleanedStatus = null;

    if (isPackageUpdate) {
      if (normalized === "packed") {
        zohoValue = "Packed";
        localCleanedStatus = "packed";
      } else if (normalized === "shipped") {
        zohoValue = "Shipped";
        localCleanedStatus = "shipped";
      } else if (normalized === "delivered") {
        zohoValue = "Delivered";
        localCleanedStatus = "delivered";
      } else {
        return c.json({ error: `Invalid package status: '${status}'. Must be: packed, shipped, delivered` }, 400);
      }
    } else {
      if (normalized === "ready-to-ship" || normalized === "readytoship") {
        zohoValue = "Ready to Ship";
        localCleanedStatus = "ready_to_ship";
      } else if (normalized === "shipped") {
        zohoValue = "Shipped";
        localCleanedStatus = "shipped";
      } else if (normalized === "delivered") {
        zohoValue = "Delivered";
        localCleanedStatus = "delivered";
      } else {
        return c.json({ error: `Invalid dispatch status: '${status}'. Must be: ready to ship, shipped, delivered` }, 400);
      }
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const zohoToken = await getZohoAccessToken(db);
      const dispatchesColl = db.collection("dispatches");

      // ----------------------------------------------------
      // 1. DIRECT DISPATCH UPDATE
      // ----------------------------------------------------
      if (!isPackageUpdate) {
        let creatorDispatchUpdated = false;
        let creatorError = null;

        try {
          await updateCreatorRecord(
            DISPATCHES_REPORT_NAME,
            "Dispatch_Number",
            dispatch_number,
            { Dispatch_Status: zohoValue },
            zohoToken
          );
          creatorDispatchUpdated = true;
        } catch (err) {
          console.error("⚠️ Creator Dispatch Update Warning:", err.message);
          creatorError = err.message;
        }

        await dispatchesColl.updateOne(
          { dispatch_number },
          {
            $set: {
              dispatch_status: zohoValue,
              status: localCleanedStatus,
              updatedAt: new Date().toISOString()
            }
          }
        );

        return c.json({
          success: true,
          message: `Dispatch [${dispatch_number}] updated to '${zohoValue}'.`,
          dispatch_number,
          dispatch_status: zohoValue,
          creator_synced: creatorDispatchUpdated,
          error: creatorError
        });
      }

      // ----------------------------------------------------
      // 2. SPECIFIC PACKAGE UPDATE
      // ----------------------------------------------------
      const dispatchDoc = await dispatchesColl.findOne({
        dispatch_number,
        "packages.package_number": package_number
      });

      if (!dispatchDoc) {
        return c.json({ error: `Package [${package_number}] not found under Dispatch [${dispatch_number}] in DB` }, 404);
      }

      let creatorPackageUpdated = false;
      let creatorError = null;

      try {
        await updateCreatorRecord(
          PACKAGES_REPORT_NAME,
          "Package_Number",
          package_number,
          { Status: zohoValue },
          zohoToken
        );
        creatorPackageUpdated = true;
      } catch (err) {
        console.error("⚠️ Creator Package Update Warning:", err.message);
        creatorError = err.message;
      }

      // Update package in MongoDB
      await dispatchesColl.updateOne(
        { dispatch_number, "packages.package_number": package_number },
        {
          $set: {
            "packages.$.status": zohoValue,
            "packages.$.localStatus": localCleanedStatus,
            "packages.$.updatedAt": new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }
      );

      // Check if all packages are delivered to auto-update Dispatch
      const updatedDoc = await dispatchesColl.findOne({ dispatch_number });
      const packagesList = updatedDoc.packages || [];
      const allDelivered = packagesList.length > 0 && packagesList.every((p) => p.status === "Delivered");

      let autoCompletedDispatch = false;

      if (allDelivered && updatedDoc.dispatch_status !== "Delivered") {
        try {
          await updateCreatorRecord(
            DISPATCHES_REPORT_NAME,
            "Dispatch_Number",
            dispatch_number,
            { Dispatch_Status: "Delivered" },
            zohoToken
          );
        } catch (err) {
          console.warn("⚠️ Creator Auto Dispatch Update Warning:", err.message);
        }

        await dispatchesColl.updateOne(
          { dispatch_number },
          {
            $set: {
              dispatch_status: "Delivered",
              status: "delivered",
              delivered_at: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          }
        );

        autoCompletedDispatch = true;
      }

      return c.json({
        success: true,
        message: `Package [${package_number}] updated to '${zohoValue}'.${autoCompletedDispatch ? " All packages delivered — Dispatch marked Delivered." : ""}`,
        dispatch_number,
        package_number,
        package_status: zohoValue,
        dispatch_status: autoCompletedDispatch ? "Delivered" : updatedDoc.dispatch_status,
        creator_synced: creatorPackageUpdated,
        creator_error: creatorError,
        all_packages_delivered: allDelivered
      });
    });

  } catch (err) {
    console.error("❌ Update Error:", err.message);
    return c.json({ error: "Internal server error", details: err.message }, 500);
  }
};




export const uploadPackageDeliveryPhotos = async (c) => {
  const tempFilePaths = [];

  try {
    // 1. Parse Multipart Form Data (Photos + Metadata)
    const body = await c.req.parseBody();
    const deal_id = body['deal_id'] || body['crm_deal_id'];
    const package_number = body['package_number'];
    const dispatch_number = body['dispatch_number']; // Optional: helps locate doc faster in Mongo
    const state = body['state'] || 'Default';

    if (!deal_id || !package_number) {
      return c.json({
        error: "Validation Error: 'deal_id' and 'package_number' are required fields."
      }, 400);
    }

    // Collect uploaded photo files (supports single or multiple file fields)
    const files = [];
    for (const key of Object.keys(body)) {
      const val = body[key];
      // Hono / standard file buffer check
      if (val && typeof val === 'object' && (val.arrayBuffer || val instanceof Blob || val.name)) {
        files.push(val);
      }
    }

    if (files.length === 0) {
      return c.json({ error: "Validation Error: No photo files found in the request." }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const zohoToken = await getZohoAccessToken(db);

      // 2. Resolve / Create the "Package" subfolder under the Deal ID in WorkDrive
      console.log(`📁 Resolving WorkDrive "Package" folder for Deal ID [${deal_id}] in [${state}]...`);
      const targetPackageFolderId = await getOrCreateLeadsSEFolder(deal_id, "Package", state);

      const uploadedFilesResults = [];

      // 3. Write each file to temp disk, upload to WorkDrive, and cleanup
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const originalName = file.name || `delivery_${Date.now()}_${i + 1}.jpg`;
        const sanitizedExt = path.extname(originalName) || '.jpg';
        const fileName = `${package_number}_delivery_${Date.now()}_${i + 1}${sanitizedExt}`;
        const tempPath = path.join(process.cwd(), fileName);

        tempFilePaths.push(tempPath);

        // Convert Blob/File to local Buffer
        const arrayBuffer = await file.arrayBuffer();
        await fs.promises.writeFile(tempPath, Buffer.from(arrayBuffer));

        console.log(`⬆️ Uploading ${fileName} to WorkDrive folder [${targetPackageFolderId}]...`);
        const uploadResult = await uploadToZohoWorkDrive(tempPath, fileName, targetPackageFolderId);
        uploadedFilesResults.push(uploadResult);
      }

      // 4. Construct the Final Shareable Link
      // If single file: use file permalink; if multiple files: link to the WorkDrive "Package" subfolder
      let finalPhotosUrl = "";
      if (uploadedFilesResults.length === 1) {
        finalPhotosUrl = uploadedFilesResults[0].url;
      } else {
        // If multiple photos, provide the first file link or the folder URL
        finalPhotosUrl = uploadedFilesResults[0].url; 
      }

      // 5. Update Zoho Creator Package Record
      console.log(`📡 Updating Zoho Creator Package [${package_number}] with delivery photo link...`);
      let creatorUpdated = false;
      let creatorError = null;

      try {
        await updateCreatorRecord(
          PACKAGES_REPORT_NAME,
          "Package_Number",
          package_number,
          {
            Package_Delivery_Photos: finalPhotosUrl
          },
          zohoToken
        );
        creatorUpdated = true;
        console.log(`✅ Zoho Creator Package [${package_number}] updated successfully.`);
      } catch (err) {
        console.error(`❌ Creator Package Delivery Photos Update Failed:`, err.message);
        creatorError = err.message;
      }

      // 6. Update MongoDB dispatches collection
      const dispatchesColl = db.collection("dispatches");
      const mongoFilter = dispatch_number 
        ? { dispatch_number, "packages.package_number": package_number }
        : { "packages.package_number": package_number };

      await dispatchesColl.updateOne(
        mongoFilter,
        {
          $set: {
            "packages.$.delivery_photos_url": finalPhotosUrl,
            "packages.$.delivery_photos_count": uploadedFilesResults.length,
            "packages.$.photos_uploaded_at": new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }
      );

      return c.json({
        success: true,
        message: `Delivery photos successfully uploaded and attached to Package [${package_number}].`,
        deal_id,
        package_number,
        package_delivery_photos: finalPhotosUrl,
        uploaded_count: uploadedFilesResults.length,
        creator_synced: creatorUpdated,
        creator_error: creatorError
      });
    });

  } catch (err) {
    console.error("❌ Upload Package Delivery Photos Failed:", err.message);
    return c.json({ error: "Internal server error", details: err.message }, 500);
  } finally {
    // Local temp file cleanup
    for (const tempPath of tempFilePaths) {
      if (fs.existsSync(tempPath)) {
        fs.unlink(tempPath, (err) => {
          if (err) console.error("⚠️ Cleanup error for file:", tempPath, err.message);
        });
      }
    }
  }
};