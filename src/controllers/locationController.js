import { withDatabase } from '../utils/config.js'; 

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
      const doc = await db.collection("locations").findOne({ phoneNo });

      if (!doc || !doc[date]) {
        // Handle first entry of the day
        await db.collection("locations").updateOne(
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

        await db.collection("locations").updateOne(
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
      const docs = await db.collection("locations").find({ phoneNo: { $in: mobiles } }).toArray();
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
      const docs = await db.collection("locations").find({ phoneNo: { $in: mobiles } }).toArray();
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

/**
 * Calculates road distance in kilometers using Google Routes API (v2)
 */
async function fetchGoogleDistanceKm(startLat, startLng, siteLat, siteLng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is not configured in environment variables");
  }

  const payload = {
    origin: {
      location: {
        latLng: {
          latitude: Number(startLat),
          longitude: Number(startLng)
        }
      }
    },
    destination: {
      location: {
        latLng: {
          latitude: Number(siteLat),
          longitude: Number(siteLng)
        }
      }
    },
    travelMode: "DRIVE"
  };

  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Routes API HTTP error: ${res.status} - ${errorText}`);
  }

  const data = await res.json();


  const route = data.routes?.[0];
  if (!route) {
    throw new Error("No route found between coordinates");
  }

  // If distanceMeters is omitted, Google calculated 0 meters (start and end are the same spot)
  const distanceMeters = route.distanceMeters ?? 0;
  const distanceKm = Math.round((distanceMeters / 1000) * 100) / 100;
  return distanceKm;
}

export const saveDealDistance = async (c) => {
  try {
    const body = await c.req.json();

    const {
      deal_id,
      deal_name,
      mobile,
      surveyor_name,
      // Existing mobile-calculated fields preserved as before
      to_home,
      to_office,
      // Coordinates needed strictly for server-side to_site calculation
      start_latitude,
      start_longitude,
      site_latitude,
      site_longitude,
      start_lat,
      start_lng,
      site_lat,
      site_lng
    } = body;

    // Resolve lat/lng from common naming variants
    const resolvedStartLat = start_latitude ?? start_lat;
    const resolvedStartLng = start_longitude ?? start_lng;
    const resolvedSiteLat = site_latitude ?? site_lat;
    const resolvedSiteLng = site_longitude ?? site_lng;

    // 1. Mandatory validation
    if (
      !deal_id ||
      !deal_name ||
      !mobile ||
      !surveyor_name ||
      resolvedStartLat === undefined ||
      resolvedStartLng === undefined ||
      resolvedSiteLat === undefined ||
      resolvedSiteLng === undefined
    ) {
      return c.json(
        {
          error: "deal_id, deal_name, mobile, surveyor_name, and valid start/site coordinates are required!"
        },
        400
      );
    }

    // 2. Compute to_site distance exclusively using Google Maps API
    const calculatedToSiteKm = await fetchGoogleDistanceKm(
      resolvedStartLat,
      resolvedStartLng,
      resolvedSiteLat,
      resolvedSiteLng
    );

    // 3. Build MongoDB document
    const distanceData = {
      deal_id,
      deal_name,
      mobile,
      to_site: calculatedToSiteKm, // Server-calculated km
      surveyor_name,
      start_location: {
        latitude: Number(resolvedStartLat),
        longitude: Number(resolvedStartLng)
      },
      site_location: {
        latitude: Number(resolvedSiteLat),
        longitude: Number(resolvedSiteLng)
      },
      createdAt: new Date()
    };

    // 4. Attach legacy mobile-computed distances untouched if supplied
    if (to_home !== undefined && to_home !== null) {
      distanceData.to_home = to_home;
    }

    if (to_office !== undefined && to_office !== null) {
      distanceData.to_office = to_office;
    }

    // 5. Database persistence
    return await withDatabase(MONGODB_URI, async (db) => {
      const collection = db.collection("deal_distance");

      // Verify no duplicate record exists
      const existingRecord = await collection.findOne({ deal_id });
      if (existingRecord) {
        return c.json({ error: "A distance record for this deal_id already exists!" }, 409);
      }

      await collection.insertOne(distanceData);

      return c.json({ message: "Deal distance saved successfully" }, 201);
    });
  } catch (err) {
    console.error("❌ saveDealDistance execution failed:", err.message);
    return c.json({ error: err.message }, 500);
  }
};



