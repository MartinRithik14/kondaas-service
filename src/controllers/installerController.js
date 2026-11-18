import { withDatabase } from '../utils/config.js'; 
import { getZohoAccessToken } from '../utils/zohoAuth.js';

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
      const doc = await db.collection("installer-location").findOne({ phoneNo });

      if (!doc || !doc[date]) {
        // Handle first entry of the day
        await db.collection("installer-location").updateOne(
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

        await db.collection("installer-location").updateOne(
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
      const docs = await db.collection("installer-location").find({ phoneNo: { $in: mobiles } }).toArray();
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
      const docs = await db.collection("installer-location").find({ phoneNo: { $in: mobiles } }).toArray();
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



export const installationWebhook = async (c) => {
  try {
    // 1. Parse incoming payload (handles JSON, urlencoded, or multipart)
    const contentType = c.req.header("content-type") || "";
    let payload = {};

    if (contentType.includes("application/json")) {
      payload = await c.req.json();
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      payload = await c.req.parseBody();
    } else {
      try {
        payload = await c.req.json();
      } catch {
        payload = await c.req.parseBody();
      }
    }

    // 2. Extract incoming fields
    const {
      id,
      installerNumber,
      installerMobile,
      customerName,
      customerPhone,
      customerMobile,
      street,
      city,
      province,
      postalCode,
      country,
      latitude,
      longitude,
      // Product & Material details
      inverterModel,
      inverterCapacity,
      inverterConnectionType,
      inverterBrand,
      solarPanelType,
      solarPanelBrand,
      noOfPanels,
      cableRequirements,
      acCable,
      dcCable,
      earthingCable,
      additionalMaterialReq,
      requiredAdditionalMaterial,
      additionalMaterialCost
    } = payload;

    // Validate Zoho record ID (sent via User defined Format)
    const zohoId = id || payload.record_id;
    if (!zohoId) {
      console.warn("⚠️ Installation Webhook received without an ID:", payload);
      return c.json({ error: "Missing record ID from Zoho" }, 400);
    }

    // Helper: clean & normalize phone numbers to standard 10 digits
    const normalizePhoneNumber = (number) => {
      if (!number) return null;
      let digits = String(number).replace(/\D/g, "");
      if (digits.length === 12 && digits.startsWith("91")) {
        digits = digits.substring(2);
      }
      return digits || null;
    };

    // 3. Resolve and normalize phone numbers
    const rawInstallerPhone = installerMobile || installerNumber || "";
    const assignedTo = normalizePhoneNumber(rawInstallerPhone);

    const rawCustomerPhone = customerMobile || customerPhone || "";
    const normalizedCustomerPhone = normalizePhoneNumber(rawCustomerPhone);

    // 4. Construct installation document
    const installationData = {
      zohoId: String(zohoId),
      assignedTo: assignedTo || null,
      installerMobile: installerMobile || null,
      installerNumber: installerNumber || null,
      customerName: customerName || null,
      customerPhone: normalizedCustomerPhone,
      customerRawPhone: customerPhone || null,
      customerRawMobile: customerMobile || null,
      location: {
        latitude: latitude ? parseFloat(latitude) || latitude : null,
        longitude: longitude ? parseFloat(longitude) || longitude : null
      },
      address: {
        street: street || null,
        city: city || null,
        province: province || null,
        postalCode: postalCode || null,
        country: country || null
      },
      productInformation: {
        inverterModel: inverterModel || null,
        inverterCapacity: inverterCapacity || null,
        inverterConnectionType: inverterConnectionType || null,
        inverterBrand: inverterBrand || null,
        solarPanelType: solarPanelType || null,
        solarPanelBrand: solarPanelBrand || null,
        noOfPanels: noOfPanels || null,
        cableRequirements: cableRequirements || null,
        acCable: acCable || null,
        dcCable: dcCable || null,
        earthingCable: earthingCable || null,
        additionalMaterialReq: additionalMaterialReq || null,
        requiredAdditionalMaterial: requiredAdditionalMaterial || null,
        additionalMaterialCost: additionalMaterialCost || null
      },
      status: "Installation Assigned",
      updatedAt: new Date()
    };

    return await withDatabase(MONGODB_URI, async (db) => {
      // 5. Upsert into the 'installation' collection
      await db.collection("installation").updateOne(
        { zohoId: String(zohoId) },
        {
          $set: installationData,
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      console.log(`✅ Installation record synced: ${zohoId} assigned to ${assignedTo}`);

      return c.json({
        success: true,
        message: "Installation record synced successfully",
        zohoId,
        assignedTo
      });
    });
  } catch (err) {
    console.error("❌ Installation Webhook Error Exception:", err.message);
    return c.json({ error: "Internal server error", details: err.message }, 500);
  }
};


export const getInstallerInstallations = async (c) => {
  try {
    // 1. Grab query params from the incoming request
    const query = c.req.query();
    let installerNumber = query.installerNumber || query.installerMobile;

    if (!installerNumber) {
      return c.json({ error: "Missing installer identity verification parameter" }, 400);
    }

    // Normalize phone number to 10 digits to match the assignedTo storage format
    installerNumber = String(installerNumber).replace(/\D/g, "");
    if (installerNumber.length === 12 && installerNumber.startsWith("91")) {
      installerNumber = installerNumber.substring(2);
    }

    // 2. Parse and sanitize pagination parameters
    const page = Math.max(1, parseInt(query.page || "1", 10));
    const limit = Math.max(1, Math.min(100, parseInt(query.limit || "10", 10)));
    const skip = (page - 1) * limit;

    return await withDatabase(MONGODB_URI, async (db) => {
      const filter = { assignedTo: installerNumber };

      // 3. Run query and total count concurrently for performance
      const [assignedInstallations, totalInstallations] = await Promise.all([
        db.collection("installation")
          .find(filter)
          .sort({ createdAt: -1 }) // Newest jobs first
          .skip(skip)
          .limit(limit)
          .toArray(),
        db.collection("installation").countDocuments(filter)
      ]);

      const totalPages = Math.ceil(totalInstallations / limit);
      const hasMore = page < totalPages;

      console.log(
        `📱 Installer Workspace [${installerNumber}] - Page ${page}/${totalPages || 1} loaded. Sent ${assignedInstallations.length} tasks (Total: ${totalInstallations}).`
      );

      // 4. Return installation jobs along with FlatList-ready pagination metadata
      return c.json(
        {
          success: true,
          installations: assignedInstallations,
          pagination: {
            total: totalInstallations,
            page,
            limit,
            totalPages,
            hasMore
          }
        },
        200
      );
    });
  } catch (err) {
    console.error("❌ Fetch Installer Dashboard Exception:", err.message);
    return c.json({ error: "Failed to pull installer task workspace" }, 500);
  }
};


export const updateInstallationStatus = async (c) => {
  try {
    const body = await c.req.json();
    const { id, status } = body;

    // 1. Parameter Validation
    if (!id || !status) {
      return c.json(
        { error: "Validation Error: Missing required fields 'id' or 'status'." },
        400
      );
    }

    // Standardize input string for robust comparison matching
    const normalizedStatus = status.toLowerCase().trim().replace(/[\s_-]+/g, "");

    // 2. Exact Mapping to Zoho's case-sensitive dropdown configurations
    let zohoValue = null;
    let localCleanedStatus = null;

    if (normalizedStatus === "installationassigned" || normalizedStatus === "assigned") {
      zohoValue = "Installation Assigned";
      localCleanedStatus = "Installation Assigned";
    } else if (
      normalizedStatus === "engineerreachessite" ||
      normalizedStatus === "reachedsite" ||
      normalizedStatus === "reached"
    ) {
      zohoValue = "Engineer Reaches Site";
      localCleanedStatus = "Engineer Reaches Site";
    } else if (
      normalizedStatus === "materialverification" ||
      normalizedStatus === "verified"
    ) {
      zohoValue = "Material Verification";
      localCleanedStatus = "Material Verification";
    } else if (normalizedStatus === "installationstart" || normalizedStatus === "start") {
      zohoValue = "Installation Start";
      localCleanedStatus = "Installation Start";
    } else if (
      normalizedStatus === "installationprogress" ||
      normalizedStatus === "inprogress" ||
      normalizedStatus === "progress"
    ) {
      zohoValue = "Installation Progress";
      localCleanedStatus = "Installation Progress";
    } else if (
      normalizedStatus === "installationcompleted" ||
      normalizedStatus === "completed"
    ) {
      zohoValue = "Installation Completed";
      localCleanedStatus = "Installation Completed";
    }

    // Fallback if the requested value doesn't match available options
    if (!zohoValue) {
      return c.json(
        {
          error: `Validation Error: '${status}' is not recognized. Must be one of: Installation Assigned, Engineer Reaches Site, Material Verification, Installation Start, Installation Progress, Installation Completed`
        },
        400
      );
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 🔐 Grab active authorization credentials dynamically
      const zohoToken = await getZohoAccessToken(db);

      // 3. Build the precise Zoho payload
      const zohoPayload = {
        data: [
          {
            id: String(id),
            Installation_Status: zohoValue
          }
        ]
      };

      console.log(
        `📡 Transmitting Targeted Dropdown Update to Zoho CRM Installation for record ID: ${id} -> Value: ${zohoValue}...`
      );

      // 4. Update Remote Zoho CRM
      const response = await fetch(`https://www.zohoapis.in/crm/v8/Installation/${id}`, {
        method: "PUT",
        headers: {
          Authorization: `Zoho-oauthtoken ${zohoToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(zohoPayload)
      });

      if (!response.ok) {
        const errTxt = await response.text();
        console.error("❌ Zoho Dropdown Update execution failed:", errTxt);
        return c.json(
          { error: "Failed to update record state on Zoho.", details: errTxt },
          500
        );
      }

      const result = await response.json();
      console.log("✅ Zoho Server Response Status Payload:", JSON.stringify(result));

      // 5. 🔄 UNIFIED STEP: Sync straight to local MongoDB "installation" collection
      console.log(
        `🔄 Syncing local status for Installation [${id}] to matching state: ${localCleanedStatus}`
      );

      const localResult = await db.collection("installation").updateOne(
        { zohoId: String(id) },
        {
          $set: {
            status: localCleanedStatus,
            updatedAt: new Date()
          }
        }
      );

      if (localResult.matchedCount === 0) {
        console.warn(
          `⚠️ Remote Zoho target updated, but no matching local record tracked for Installation ID: ${id}`
        );
      } else {
        console.log(
          `✅ Successfully shifted status locally for Installation [${id}] to: ${localCleanedStatus}`
        );
      }

      return c.json({
        success: true,
        message: `Installation Status successfully transitioned to '${zohoValue}' inside both Zoho and local database.`,
        id: id,
        currentLocalStatus: localCleanedStatus
      });
    });
  } catch (err) {
    console.error("❌ Dropdown Update Exception Error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
};


export const updateInstallationDetails = async (c) => {
  try {
    const contentType = c.req.header("content-type") || "";
    let id = null;
    let fieldsToUpdate = {};
    const photoFiles = [];

    // 1. Parse Multipart (FormData with files & fields) or JSON Body
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      id = body.id;

      // Extract raw files and structured field updates
      for (const [key, val] of Object.entries(body)) {
        if (key === "id") continue;

        // Collect uploaded photos/files
        if (val instanceof File || (Array.isArray(val) && val[0] instanceof File)) {
          const filesArr = Array.isArray(val) ? val : [val];
          filesArr.forEach((file) => photoFiles.push({ fieldName: key, file }));
        } else {
          // If fields are passed as a JSON string under a "fields" or "data" key
          if (key === "fields" || key === "data") {
            try {
              Object.assign(fieldsToUpdate, JSON.parse(val));
            } catch {
              fieldsToUpdate[key] = val;
            }
          } else {
            fieldsToUpdate[key] = val;
          }
        }
      }
    } else {
      // Standard JSON request
      const body = await c.req.json();
      id = body.id;
      const { fields, ...rest } = body;
      fieldsToUpdate = fields ? { ...fields } : { ...rest };
    }

    // 2. Validate Target Record ID
    if (!id) {
      return c.json({ error: "Validation Error: Missing required 'id' (Zoho Installation ID)." }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 🔐 Grab active Zoho OAuth access token
      const zohoToken = await getZohoAccessToken(db);
      const zohoHeaders = {
        Authorization: `Zoho-oauthtoken ${zohoToken}`
      };

      let zohoUpdateResult = null;
      const uploadedAttachments = [];

      // 3. Update Dynamic Zoho CRM Fields (if any are supplied)
      if (Object.keys(fieldsToUpdate).length > 0) {
        const zohoPayload = {
          data: [
            {
              id: String(id),
              ...fieldsToUpdate
            }
          ]
        };

        console.log(`📡 Sending dynamic field updates to Zoho Installation [${id}]:`, fieldsToUpdate);

        const updateRes = await fetch(`https://www.zohoapis.in/crm/v8/Installation/${id}`, {
          method: "PUT",
          headers: {
            ...zohoHeaders,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(zohoPayload)
        });

        if (!updateRes.ok) {
          const errTxt = await updateRes.text();
          console.error(`❌ Zoho Installation details update failed [${id}]:`, errTxt);
          return c.json({ error: "Failed to update fields on Zoho CRM", details: errTxt }, 500);
        }

        zohoUpdateResult = await updateRes.json();
      }

      // 4. Upload Attached Photos directly to Zoho CRM record attachments
      if (photoFiles.length > 0) {
        console.log(`📸 Uploading ${photoFiles.length} file(s) for Installation [${id}]...`);

        for (const item of photoFiles) {
          const formData = new FormData();
          formData.append("file", item.file, item.file.name || `${item.fieldName}.jpg`);

          const uploadRes = await fetch(
            `https://www.zohoapis.in/crm/v8/Installation/${id}/Attachments`,
            {
              method: "POST",
              headers: zohoHeaders, // FormData sets boundary automatically
              body: formData
            }
          );

          if (uploadRes.ok) {
            const uploadJson = await uploadRes.json();
            uploadedAttachments.push({
              field: item.fieldName,
              fileName: item.file.name,
              zohoAttachment: uploadJson.data?.[0] || null
            });
          } else {
            const uploadErr = await uploadRes.text();
            console.error(`⚠️ Failed to attach ${item.fieldName} for [${id}]:`, uploadErr);
          }
        }
      }

      // 5. Sync the updated fields locally in MongoDB
      const mongoSetUpdates = {
        updatedAt: new Date()
      };

      for (const [k, v] of Object.entries(fieldsToUpdate)) {
        // Keeps the local schema aligned with whatever Zoho fields changed
        mongoSetUpdates[`zohoFields.${k}`] = v;
      }

      if (fieldsToUpdate.Status || fieldsToUpdate.Installation_Status) {
        mongoSetUpdates.status = fieldsToUpdate.Status || fieldsToUpdate.Installation_Status;
      }

      const mongoUpdateQuery = {
        $set: mongoSetUpdates
      };

      if (uploadedAttachments.length > 0) {
        mongoUpdateQuery.$push = {
          attachments: { $each: uploadedAttachments }
        };
      }

      await db.collection("installation").updateOne(
        { zohoId: String(id) },
        mongoUpdateQuery
      );

      console.log(`✅ Successfully synced dynamic fields & media for Installation [${id}]`);

      return c.json({
        success: true,
        message: "Installation details and photos successfully updated",
        id,
        updatedFields: fieldsToUpdate,
        attachmentsUploaded: uploadedAttachments.length
      }, 200);
    });

  } catch (err) {
    console.error("❌ Update Installation Details Exception:", err.message);
    return c.json({ error: "Internal server error", details: err.message }, 500);
  }
};