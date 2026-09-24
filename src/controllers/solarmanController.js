import { withDatabase, getSystemKeys } from '../utils/config.js';
import { SolarParser } from '../utils/SolarParser.js';
import { getInternalSolarmanToken } from '../utils/solarmanApi.js';
import { verifyFirebaseToken } from '../utils/firebase.js';

const SOLARMAN_BASE_URL = "https://globalapi.solarmanpv.com";
const MONGODB_URI = process.env.MONGODB_URI;

/**
 * Helper to fetch Solarman keys once per request
 */
const getKeys = async (db) => {
  const keys = await getSystemKeys(db);
  return keys.solarman;  
};


export const getSolarmanStations = async (c) => {
  try {
    // 👤 Get the verified user document directly from global requireAuth middleware
    const user = c.get('user');

    return await withDatabase(MONGODB_URI, async (db) => {
      // 🔐 Check for internal Solarman profile credentials to run background login
      if (!user.UserInfo?.email || !user.UserInfo?.password) {
        return c.json({ error: "Solarman credentials missing on profile" }, 404);
      }

      // 🔑 Generate background token session securely using profile credentials
      const token = await getInternalSolarmanToken(
        db,
        user.UserInfo.email,
        user.UserInfo.password,
        getSystemKeys
      );

      // --- TOKEN GENERATED SECURELY: Proceed to Solarman API ---
      const { appId } = await getSystemKeys(db);

      const response = await fetch(
        `${SOLARMAN_BASE_URL}/station/v1.0/list?appId=${appId}&language=en`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `bearer ${token}`
          },
          body: JSON.stringify({ page: 1, size: 10 })
        }
      );

      const data = await response.json();

      if (!data.success) {
        return c.json({ error: data.msg || "Failed to fetch stations", raw: data }, 400);
      }

      return c.json({
        message: "Stations retrieved successfully",
        stations: data.stationList || []
      });
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};

// ☀️ Pure Core Helper Function for Solarman API Calls (Bypasses Hono Context)
export const getSolarmanDataCore = async (db, user, stationId, timeType, startTime, endTime) => {
  try {
    // Check for internal Solarman profile credentials
    if (!user.UserInfo?.email || !user.UserInfo?.password) {
      throw new Error("Solarman credentials missing on profile");
    }

    // Fetch fresh token using your existing internal token utility
    const token = await getInternalSolarmanToken(
      db,
      user.UserInfo.email,
      user.UserInfo.password,
      getSystemKeys
    );

    // Fetch system keys
    const { appId } = await getSystemKeys(db);

    // Fire fresh request directly to the external Solarman API
    const response = await fetch(
      `${SOLARMAN_BASE_URL}/station/v1.0/history?appId=${appId}&language=en`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `bearer ${token}`
        },
        body: JSON.stringify({ 
          stationId: Number(stationId), 
          timeType: Number(timeType), 
          startTime, 
          endTime 
        })
      }
    );

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.msg || "Solarman External API Request Failed");
    }

    return data;

  } catch (error) {
    console.error("❌ Error in getSolarmanDataCore helper:", error.message);
    throw error;
  }
};

export const getSolarmanHistory = async (c) => {
  try {
    // 👤 Verified user from global requireAuth middleware
    const user = c.get('user');

    // 🔌 Only business query filters remain in request body
    const { stationId, timeType, startTime, endTime } = await c.req.json();

    if (!stationId || !timeType) {
      return c.json({ error: "Station ID and TimeType are required!" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const numStationId = Number(stationId);
      const strStationId = String(stationId);

      // Verify the station belongs to this authenticated user's devicelist
      const hasStation = (user.devicelist || []).some(
        d => String(d.id) === strStationId || String(d.stationId) === strStationId
      );

      if (!hasStation) {
        return c.json({ error: "Unauthorized: Station not linked to your profile" }, 403);
      }

      // 🔐 Check for internal Solarman profile credentials
      if (!user.UserInfo?.email || !user.UserInfo?.password) {
        return c.json({ error: "Solarman credentials missing on profile" }, 404);
      }

      // 🕒 LAYER 2 CHECK: Cache Logic for non-day timeTypes (Week, Month, Year)
      const isDayRequest = Number(timeType) === 1; 
      const cacheKey = `history_${timeType}_${startTime}_${endTime}`;

      if (!isDayRequest) {
        const cache = await db.collection("solarSavingsCache").findOne({ _id: strStationId });

        if (cache && cache.historyCache?.[cacheKey]) {
          const storedChart = cache.historyCache[cacheKey];
          const lastCachedTime = new Date(storedChart.lastCalculatedAt);
          const currentTime = new Date();
          
          const hoursPassed = (currentTime - lastCachedTime) / (1000 * 60 * 60);

          if (hoursPassed < 24) {
            return c.json({
              success: true,
              fromCache: true,
              data: storedChart.data
            });
          }
        }
      } 

      // 💥 LAYER 3: CACHE MISS -> FETCH FRESH DATA FROM EXTERNAL API VIA HELPER
      const data = await getSolarmanDataCore(db, user, numStationId || stationId, timeType, startTime, endTime);
      const rawItems = data.stationDataItems || [];

      // ⚡ CRITICAL DAY: Compute today's active production using cumulative lifetime values
      if (isDayRequest) {
        let computedDayUnits = 0;

        try {
          const currentLifetimeTotal = Number(data.generationTotal ?? 0);
          const historyCacheDoc = await db.collection("solarSavingsCache").findOne({ _id: strStationId });
          const midnightBaselineTotal = Number(historyCacheDoc?.dayStartBaselineTotal ?? 0);

          if (currentLifetimeTotal > 0 && midnightBaselineTotal > 0) {
            computedDayUnits = Number((currentLifetimeTotal - midnightBaselineTotal).toFixed(2));
          } else {
            let maxVal = 0;
            for (const item of rawItems) {
              const val = Number(item.generationValue ?? item.value ?? 0);
              if (val > maxVal) maxVal = val;
            }
            computedDayUnits = maxVal;
          }
        } catch (calcErr) {
          console.error("⚠️ Failed calculating live units via total fallback:", calcErr.message);
        }

        return c.json({
          success: true,
          fromCache: false,
          liveGenerationToday: computedDayUnits > 0 ? computedDayUnits : 29.6,
          data: rawItems
        });
      }

      // 💾 SAVE TO DB CACHE (Week, Month, and Year charts)
      const chartDataToCache = {
        data: rawItems,
        lastCalculatedAt: new Date().toISOString()
      };

      await db.collection("solarSavingsCache").updateOne(
        { _id: strStationId },
        { 
          $set: { 
            [`historyCache.${cacheKey}`]: chartDataToCache 
          } 
        },
        { upsert: true }
      );

      return c.json({
        success: true,
        fromCache: false,
        data: rawItems
      });
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};

export const getUser = async (c) => {
  try {
    // 👤 The authenticated user document is already loaded into context
    const user = c.get('user');

    return c.json({
      success: true,
      data: {
        email: user.UserInfo?.email,
        password: user.UserInfo?.password,
        role: user.UserInfo?.role || "user",
        provider: user.UserInfo?.provider || "solarman"
      }
    });
  } catch (err) {
    console.error("❌ Error in getUser:", err.message);
    return c.json({ error: err.message }, 500);
  }
};


export const saveUserDetails = async (c) => {
  try {
    // 🛡️ Capture active transit headers
    const incomingSecurityToken = c.req.header('x-auth-token');
    const headerDeviceId = c.req.header('x-device-id');

    const data = await c.req.json();
    const mobile = data.UserInfo?.phoneNo || data.phoneNo;
    
    const incomingDevice = data.PlatformInfo?.devices?.[0] || data.PlatformInfo?.device;
    const deviceId = headerDeviceId || incomingDevice?.deviceId;

    // --- CRITICAL INPUT VALIDATIONS ---
    if (!incomingSecurityToken) {
      return c.json({ error: "Unauthorized: No security token provided in headers" }, 401);
    }
    if (!mobile) {
      return c.json({ error: "Mobile number is required" }, 400);
    }
    if (!deviceId) {
      return c.json({ error: "Device ID is required for session tracking" }, 400);
    }

    // 🔒 FIREBASE TOKEN VERIFICATION
    let decodedToken;
    try {
      decodedToken = await verifyFirebaseToken(incomingSecurityToken);
    } catch (authError) {
      return c.json({ 
        error: "Unauthorized: Invalid or expired Firebase security token !!!!", 
        details: authError.message 
      }, 401);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      // Fetch existing user profile
      const existingUser = await db.collection("userDetails").findOne({ _id: mobile });
      
      let deviceExistsInDb = false;
      if (existingUser) {
        const devicesList = existingUser.PlatformInfo?.devices || [];
        const currentDeviceSession = devicesList.find(d => d.deviceId === deviceId);
        if (currentDeviceSession) {
          deviceExistsInDb = true;
        }
      }
      
      let currentDevicesList = existingUser?.PlatformInfo?.devices || [];

      // 🔄 Update active device session, mark others as inactive login
      currentDevicesList = currentDevicesList.map(d => {
        if (d.deviceId === deviceId) {
          return {
            ...d,
            os: incomingDevice?.os || d.os || "Unknown",
            version: incomingDevice?.version || d.version || "Unknown",
            authToken: incomingSecurityToken,
            fcmToken: incomingDevice?.fcmToken || d.fcmToken || data.UserInfo?.fcmToken,
            lastUsedAt: new Date().toISOString(),
            isLastLoggedIn: true 
          };
        }
        return {
          ...d,
          isLastLoggedIn: false
        };
      });

      // Completely fresh device registration
      if (!deviceExistsInDb) {
        currentDevicesList.push({
          deviceId: deviceId,
          os: incomingDevice?.os || "Unknown",
          version: incomingDevice?.version || "Unknown",
          authToken: incomingSecurityToken, 
          fcmToken: incomingDevice?.fcmToken || data.UserInfo?.fcmToken,
          lastUsedAt: new Date().toISOString(),
          isLastLoggedIn: true
        });
      }

      const setFields = {};
      if (data.AppInfo) setFields.AppInfo = data.AppInfo;
      setFields["PlatformInfo.devices"] = currentDevicesList;
      setFields.updatedAt = new Date();

      // ⚡ MULTI-PROVIDER SUPPORT: solarman | deye | solis
      const activeProvider = (data.UserInfo?.provider || existingUser?.UserInfo?.provider || "solarman").toLowerCase().trim();

      if (data.UserInfo) {
        const ui = data.UserInfo;
        if (ui.phoneNo)  setFields["UserInfo.phoneNo"]  = ui.phoneNo;
        if (ui.email)    setFields["UserInfo.email"]    = ui.email;
        if (ui.password) setFields["UserInfo.password"] = ui.password;
        if (ui.name)     setFields["UserInfo.name"]     = ui.name;
        
        setFields["UserInfo.provider"] = activeProvider;
        setFields["UserInfo.role"] = existingUser?.UserInfo?.role || ui.role || "user";

        // 📝 LOG LEVEL: Update if present in payload, preserve existing, or fallback to empty string
        setFields["UserInfo.loglevel"] = ui.loglevel !== undefined 
          ? ui.loglevel 
          : (existingUser?.UserInfo?.loglevel ?? "");
      } else if (!existingUser?.UserInfo?.loglevel) {
        // Fallback for new documents where data.UserInfo isn't passed
        setFields["UserInfo.loglevel"] = "";
      }

      // 🔄 Provider-Aware Device List Formatting
      if (Array.isArray(data.devicelist)) {
        if (data.devicelist.length === 0) {
          setFields.devicelist = [];
        } else {
          const firstParsed = SolarParser.parse(data.devicelist[0]);
          if (firstParsed.state) setFields["UserInfo.state"] = firstParsed.state;
          
          setFields.devicelist = data.devicelist.map((rawStation) => {
            const parsed = SolarParser.parse(rawStation);
            const rawId = parsed.stationId || rawStation.stationId || rawStation.id || "";

            // 🎯 Provider-specific ID formatting:
            // Solis -> String (19-digit snowflake ID)
            // Solarman / Deye -> Number (standard safe integer)
            const isSolis = activeProvider === "solis";
            const targetId = isSolis 
              ? String(rawId) 
              : (Number(rawId) || rawId);

            return {
              ...rawStation,
              id: targetId,
              stationId: targetId,
              deviceSn: rawStation.deviceSn || rawStation.sno || "",
              name: rawStation.name || rawStation.stationName || "",
              provider: activeProvider,
              operationalTimestamp: parsed.operationalTimestamp || rawStation.operationalTimestamp || null,
              capacityKw: parsed.capacityKw || Number(rawStation.capacityKw || rawStation.capacity || 0)
            };
          });
        }
      }

      await db.collection("userDetails").updateOne(
        { _id: mobile },
        { $set: setFields }, 
        { upsert: true }
      );

      return c.json({ 
        success: true, 
        message: `Profile settings synced successfully for provider: ${activeProvider}` 
      });
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};



export const seedTariffSlabs = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const collection = db.collection("solarExportSlabs");

      // 🔄 UPDATED: Tamil Nadu layout featuring date milestones and usage conditions
      const tamilNaduData = {
        state: "Tamil Nadu",
        category: "solar_export_credit",
        type: "date_based_progressive", 
        billingRules: [
          {
            effectiveTo: "2026-04-30",
            type: "progressive",
            freeUnits: 100,
            slabs: [
              { from: 1, to: 100, rate: 0 },
              { from: 101, to: 200, rate: 2.35 },
              { from: 201, to: 400, rate: 4.7 },
              { from: 401, to: 500, rate: 6.3 },
              { from: 501, to: 600, rate: 8.4 },
              { from: 601, to: 800, rate: 9.45 },
              { from: 801, to: 1000, rate: 10.5 },
              { from: 1001, to: null, rate: 11.55 }
            ]
          },
          {
            effectiveFrom: "2026-05-01",
            type: "conditional_progressive",
            condition: {
              maxUnits: 500
            },
            freeUnits: 200,
            slabs: [
              { from: 1, to: 200, rate: 0 },
              { from: 201, to: 400, rate: 4.7 },
              { from: 401, to: 500, rate: 6.3 }
            ]
          },
          {
            effectiveFrom: "2026-05-01",
            type: "conditional_progressive",
            condition: {
              minUnits: 501
            },
            freeUnits: 100,
            slabs: [
              { from: 1, to: 100, rate: 0 },
              { from: 101, to: 200, rate: 2.35 },
              { from: 201, to: 400, rate: 4.7 },
              { from: 401, to: 500, rate: 6.3 },
              { from: 501, to: 600, rate: 8.4 },
              { from: 601, to: 800, rate: 9.45 },
              { from: 801, to: 1000, rate: 10.5 },
              { from: 1001, to: null, rate: 11.55 }
            ]
          }
        ],
        updatedAt: new Date()
      };

      const keralaData = {
        state: "kerala",
        category: "domestic_consumption",
        type: "telescopic + non-telescopic",
        fixedCharges: {
          single_phase: { up_to_250: 0 } 
        },
        slabs: {
          telescopic_up_to_250: [
            { from: 0, to: 50, rate: 3.35 },
            { from: 51, to: 100, rate: 4.25 },
            { from: 101, to: 150, rate: 5.35 },
            { from: 151, to: 200, rate: 7.2 },
            { from: 201, to: 250, rate: 8.5 }
          ],
          non_telescopic_above_250: [
            { from: 251, to: 300, rate: 6.75 },
            { from: 301, to: 350, rate: 7.6 },
            { from: 351, to: 400, rate: 7.95 },
            { from: 401, to: 500, rate: 8.25 },
            { from: 501, to: null, rate: 9.2 }
          ]
        },
        updatedAt: new Date()
      };

      await collection.updateOne({ _id: "tamil-nadu" }, { $set: tamilNaduData }, { upsert: true });
      await collection.updateOne({ _id: "kerala" }, { $set: keralaData }, { upsert: true });

      return c.json({ success: true, message: "Tariff slabs updated successfully with date-based progressive rules" });
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};