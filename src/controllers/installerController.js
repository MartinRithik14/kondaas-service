import { withDatabase } from '../utils/config.js'; 
import admin from "firebase-admin";

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
      installerMobile,
      installerNumber,
      longitude,
      latitude,
      country,
      postalCode,
      province,
      city,
      street,
      leadSource,
      customerName
    } = payload;

    // Validate Zoho record ID
    const zohoId = id || payload.record_id;
    if (!zohoId) {
      console.warn("⚠️ Installation Webhook received without an ID:", payload);
      return c.json({ error: "Missing record ID from Zoho" }, 400);
    }

    // 3. Resolve and normalize assignedTo phone number (10 digits)
    let rawPhone = installerMobile || installerNumber || "";
    let assignedTo = String(rawPhone).replace(/\D/g, "");
    if (assignedTo.length === 12 && assignedTo.startsWith("91")) {
      assignedTo = assignedTo.substring(2);
    }

    // 4. Construct installation document
    const installationData = {
      zohoId: String(zohoId),
      assignedTo: assignedTo || null,
      installerMobile: installerMobile || null,
      installerNumber: installerNumber || null,
      customerName: customerName || null,
      leadSource: leadSource || null,
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
      status: "assigned",
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