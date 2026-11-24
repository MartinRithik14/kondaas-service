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

    // Fail-safe: Unpack bundled query parameters if Zoho passed them inside 'id'
    let rawId = payload.id || payload.record_id || "";
    if (typeof rawId === "string" && rawId.includes("&")) {
      const parts = rawId.split("&");
      rawId = parts[0]; // Actual Zoho Record ID (e.g. 923194000015057014)

      // Extract trailing key-values into payload if not already present
      for (let i = 1; i < parts.length; i++) {
        const [paramKey, paramVal] = parts[i].split("=");
        if (paramKey && !payload[paramKey]) {
          payload[paramKey] = decodeURIComponent(paramVal || "");
        }
      }
    }

    // 2. Extract incoming fields
    const {
      installerNumber,
      installerMobile,
      customerName,
      customerPhone,
      customerMobile,
      street,
      city,
      planned,
      installationId,
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

    const zohoId = rawId;
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
      installationId: installationId || null,
      planned: planned || null,
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
    const fieldsToUpdate = {};
    const photoUploads = [];

    // Helper to detect multipart binary files
    const isFileObject = (val) => {
      if (!val) return false;
      return (
        val instanceof File ||
        (typeof val === "object" && typeof val.arrayBuffer === "function") ||
        (typeof val === "object" && val.name && val.type && typeof val.size === "number")
      );
    };

    // 1. Parse incoming Multipart or JSON
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      id = body.id;

      for (const [key, val] of Object.entries(body)) {
        if (key === "id") continue;

        const values = Array.isArray(val) ? val : [val];
        const files = values.filter(isFileObject);

        if (files.length > 0) {
          files.forEach((file) => {
            photoUploads.push({ fieldApiName: key, file });
          });
        } else {
          const rawVal = Array.isArray(val) ? val[0] : val;
          if (key === "fields" || key === "data") {
            try {
              Object.assign(fieldsToUpdate, JSON.parse(rawVal));
            } catch {
              fieldsToUpdate[key] = rawVal;
            }
          } else {
            fieldsToUpdate[key] = rawVal;
          }
        }
      }
    } else {
      const body = await c.req.json();
      id = body.id;
      const { fields, ...rest } = body;
      Object.assign(fieldsToUpdate, fields ? fields : rest);
    }

    if (!id) {
      return c.json({ error: "Validation Error: Missing required 'id' (Zoho Installation ID)." }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const zohoToken = await getZohoAccessToken(db);
      const zohoHeaders = {
        Authorization: `Zoho-oauthtoken ${zohoToken}`
      };

      const uploadedImages = [];

      // 2. Upload each photo to Zoho Files API (ZFS)
      for (const item of photoUploads) {
        const arrayBuffer = await item.file.arrayBuffer();
        const fileBlob = new Blob([arrayBuffer], { type: item.file.type || "image/jpeg" });

        const fileFormData = new FormData();
        fileFormData.append("file", fileBlob, item.file.name || `${item.fieldApiName}.jpg`);

        const fileUploadRes = await fetch("https://www.zohoapis.in/crm/v8/files", {
          method: "POST",
          headers: zohoHeaders,
          body: fileFormData
        });

        if (fileUploadRes.ok) {
          const fileResJson = await fileUploadRes.json();
          const fileId = fileResJson.data?.[0]?.details?.id;

          if (fileId) {
            fieldsToUpdate[item.fieldApiName] = [
              {
                File_Id__s: fileId
              }
            ];

            uploadedImages.push({
              field: item.fieldApiName,
              fileId: fileId,
              fileName: item.file.name
            });
          } else {
            console.warn(`⚠️ No file ID returned for ${item.fieldApiName}:`, fileResJson);
          }
        } else {
          const fileErr = await fileUploadRes.text();
          console.error(`❌ Zoho Files API Upload Failed for ${item.fieldApiName}:`, fileErr);
        }
      }

      // 3. Update the Zoho CRM Record with text fields and mapped file_ids
      if (Object.keys(fieldsToUpdate).length > 0) {
        const payloadData = {
          data: [
            {
              id: String(id),
              ...fieldsToUpdate
            }
          ]
        };

        const updateRes = await fetch(`https://www.zohoapis.in/crm/v8/Installation/${id}`, {
          method: "PUT",
          headers: {
            ...zohoHeaders,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payloadData)
        });

        const updateJson = await updateRes.json();

        if (!updateRes.ok || updateJson.data?.[0]?.status === "error") {
          console.error("📡 Sent Payload to Zoho was:\n", JSON.stringify(payloadData, null, 2));
          console.error("❌ Full Zoho Error Details:\n", JSON.stringify(updateJson, null, 2));
          return c.json({ error: "Failed to update record fields on Zoho CRM", details: updateJson }, 500);
        }
      }

      const timestamp = new Date();

      // 4. Update MongoDB Document Locally
      const mongoSetUpdates = {
        updatedAt: timestamp
      };

      for (const [k, v] of Object.entries(fieldsToUpdate)) {
        mongoSetUpdates[`zohoFields.${k}`] = v;
      }

      if (fieldsToUpdate.Status || fieldsToUpdate.Installation_Status) {
        mongoSetUpdates.status = fieldsToUpdate.Status || fieldsToUpdate.Installation_Status;
      }

      const mongoUpdateQuery = {
        $set: mongoSetUpdates
      };

      if (uploadedImages.length > 0) {
        mongoUpdateQuery.$push = {
          uploadedPhotos: { $each: uploadedImages }
        };
      }

      // 5. Concurrently sync 'installation' and log to 'installation-forms'
      await Promise.all([
        db.collection("installation").updateOne(
          { zohoId: String(id) },
          mongoUpdateQuery
        ),
        db.collection("installation-forms").insertOne({
          installationId: String(id),
          zohoId: String(id),
          formData: fieldsToUpdate,
          uploadedPhotos: uploadedImages,
          submittedAt: timestamp,
          createdAt: timestamp
        })
      ]);

      return c.json({
        success: true,
        message: "Installation fields, photos, and form records processed successfully",
        id,
        updatedFields: fieldsToUpdate,
        photosUploaded: uploadedImages
      }, 200);
    });

  } catch (err) {
    console.error("❌ Update Installation Details Exception:", err.message);
    return c.json({ error: "Internal server error", details: err.message }, 500);
  }
};

// Notes section on Installation on Zoho CRM
export const addInstallationNote = async (c) => {
  try {
    const { installation_id, content, title } = await c.req.json();

    // 1. Validation
    if (!installation_id) {
      return c.json({ error: "Missing required parameter: 'installation_id'" }, 400);
    }

    if (!content || !String(content).trim()) {
      return c.json({ error: "Missing required parameter: 'content'" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // 2. Retrieve Zoho Access Token
      const zohoToken = await getZohoAccessToken(db);

      // 3. Prepare Note Payload for Zoho CRM
      const notePayload = {
        Note_Title: title ? String(title).trim() : "Installation Note",
        Note_Content: String(content).trim()
      };

      // 4. Attach Note to Installation via Related List Endpoint
      const zohoResponse = await fetch(
        `https://www.zohoapis.in/crm/v8/Installation/${installation_id}/Notes`,
        {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${zohoToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ data: [notePayload] })
        }
      );

      const result = await zohoResponse.json();

      if (!zohoResponse.ok || (result.data && result.data[0]?.status === "error")) {
        console.error("❌ Zoho CRM Note creation error:", JSON.stringify(result, null, 2));
        return c.json(
          {
            error: "Failed to create note in Zoho CRM",
            details: result
          },
          zohoResponse.status >= 400 ? zohoResponse.status : 500
        );
      }

      const noteDetails = result.data?.[0]?.details || {};
      const noteRecord = {
        noteId: noteDetails.id || null,
        title: notePayload.Note_Title,
        content: notePayload.Note_Content,
        createdAt: new Date()
      };

      // 5. Audit the note locally in MongoDB
      await db.collection("installation").updateOne(
        { zohoId: String(installation_id) },
        {
          $push: { notes: noteRecord },
          $set: { updatedAt: new Date() }
        }
      );

      return c.json({
        success: true,
        message: "Note added to installation successfully",
        installation_id,
        note: noteRecord,
        zohoResult: result.data?.[0] || result
      });
    });
  } catch (error) {
    console.error("❌ Error in addInstallationNote handler:", error.message);
    return c.json({ error: "Internal Server Error", details: error.message }, 500);
  }
};


export const installationCheckIn = async (c) => {
  try {
    const contentType = c.req.header("content-type") || "";
    let id = null;
    let latitude = null;
    let longitude = null;
    let checkInTime = null;
    let photoFile = null;

    // Helper: checks whether an incoming value is a file/binary upload
    const isFileObject = (val) => {
      if (!val) return false;
      return (
        val instanceof File ||
        (typeof val === "object" && typeof val.arrayBuffer === "function") ||
        (typeof val === "object" && val.name && val.type && typeof val.size === "number")
      );
    };

    // 1. Parse Multipart (FormData)
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      id = body.id;
      latitude = body.Check_in_Latitude || body.latitude;
      longitude = body.Check_in_Longitude || body.longitude;
      checkInTime = body.Engineer_Check_in_Time || body.checkInTime;

      // Extract the photo file (matches 'Engineer_Check_in_Photo' or any passed binary file)
      for (const [key, val] of Object.entries(body)) {
        const fileObj = Array.isArray(val) ? val[0] : val;
        if (isFileObject(fileObj)) {
          photoFile = fileObj;
          break;
        }
      }
    } else {
      const body = await c.req.json();
      id = body.id;
      latitude = body.Check_in_Latitude || body.latitude;
      longitude = body.Check_in_Longitude || body.longitude;
      checkInTime = body.Engineer_Check_in_Time || body.checkInTime;
    }

    if (!id) {
      return c.json({ error: "Validation Error: Missing required 'id' (Zoho Installation ID)." }, 400);
    }

    const currentTimestamp = new Date();
    // Default to ISO 8601 string if mobile did not explicitly provide check-in time
    const formattedCheckInTime = checkInTime || currentTimestamp.toISOString();

    return await withDatabase(MONGODB_URI, async (db) => {
      const zohoToken = await getZohoAccessToken(db);
      const zohoHeaders = {
        Authorization: `Zoho-oauthtoken ${zohoToken}`
      };

      const fieldsToUpdate = {
        Engineer_Check_in_Time: formattedCheckInTime
      };

      if (latitude !== undefined && latitude !== null) {
        fieldsToUpdate.Check_in_Latitude = String(latitude);
      }
      if (longitude !== undefined && longitude !== null) {
        fieldsToUpdate.Check_in_Longitude = String(longitude);
      }

      let uploadedPhotoId = null;

      // 2. Upload photo to Zoho Files API (ZFS) if provided
      if (photoFile) {
        const arrayBuffer = await photoFile.arrayBuffer();
        const fileBlob = new Blob([arrayBuffer], { type: photoFile.type || "image/jpeg" });

        const fileFormData = new FormData();
        fileFormData.append("file", fileBlob, photoFile.name || "Engineer_Check_in_Photo.jpg");

        const fileUploadRes = await fetch("https://www.zohoapis.in/crm/v8/files", {
          method: "POST",
          headers: zohoHeaders,
          body: fileFormData
        });

        if (fileUploadRes.ok) {
          const fileResJson = await fileUploadRes.json();
          uploadedPhotoId = fileResJson.data?.[0]?.details?.id;

          if (uploadedPhotoId) {
            // Bind using Zoho v8 File_Id__s standard
            fieldsToUpdate.Engineer_Check_in_Photo = [
              {
                File_Id__s: uploadedPhotoId
              }
            ];
          } else {
            console.warn("⚠️ No file ID returned for Engineer_Check_in_Photo:", fileResJson);
          }
        } else {
          const fileErr = await fileUploadRes.text();
          console.error("❌ Zoho Files API Upload Failed for Engineer_Check_in_Photo:", fileErr);
        }
      }

      // 3. Update the Installation record on Zoho CRM
      const updateRes = await fetch(`https://www.zohoapis.in/crm/v8/Installation/${id}`, {
        method: "PUT",
        headers: {
          ...zohoHeaders,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          data: [
            {
              id: String(id),
              ...fieldsToUpdate
            }
          ]
        })
      });

      const updateJson = await updateRes.json();

      if (!updateRes.ok || updateJson.data?.[0]?.status === "error") {
        console.error(`❌ Zoho Installation check-in rejected for [${id}]:`, updateJson);
        
        console.error("📡 Sent Payload was:", JSON.stringify(fieldsToUpdate, null, 2));
        console.error("❌ Full Zoho Error Details:", JSON.stringify(updateJson, null, 2));
        return c.json({ error: "Failed to record check-in on Zoho CRM", details: updateJson }, 500);
      }

      // 4. Update MongoDB Document Locally
      const checkInRecord = {
        checkInTime: new Date(formattedCheckInTime),
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        photoFileId: uploadedPhotoId || null,
        submittedAt: currentTimestamp
      };

      await db.collection("installation").updateOne(
        { zohoId: String(id) },
        {
          $set: {
            checkIn: checkInRecord,
            status: "Engineer Checked-in",
            updatedAt: currentTimestamp
          }
        }
      );

      return c.json({
        success: true,
        message: "Engineer check-in recorded successfully",
        id,
        checkIn: checkInRecord
      }, 200);
    });

  } catch (err) {
    console.error("❌ Installation Check-In Exception:", err.message);
    return c.json({ error: "Internal server error", details: err.message }, 500);
  }
};