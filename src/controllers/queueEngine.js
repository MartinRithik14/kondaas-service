// src/controllers/queueEngine.js
import { withDatabase } from '../utils/config.js';
import { getSolarmanDataCore } from './solarmanController.js'; 
import admin from 'firebase-admin';
import { trackEmployeeDealCreation } from "./orderController.js";
import { getZohoAccessToken } from '../utils/zohoAuth.js'; 

// 🌐 Global Production Database Configuration Connection Key
const MONGODB_URI = process.env.MONGODB_URI;

/**
 * Returns current Date components evaluated specifically in India Time (Asia/Kolkata)
 */
const getIndiaDateParts = (date = new Date()) => {
  const options = { timeZone: 'Asia/Kolkata', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...options,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });

  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10) - 1, // 0-indexed
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10)
  };
};

/**
 * Helper to build an absolute UTC Date instance corresponding to target IST parameters
 */
const createISTDate = (year, month, day, hours = 20, minutes = 0, seconds = 0) => {
  // IST is UTC + 5 hours 30 minutes
  const pad = (num) => String(num).padStart(2, '0');
  const monthStr = pad(month + 1);
  const dayStr = pad(day);
  const hourStr = pad(hours);
  const minStr = pad(minutes);
  const secStr = pad(seconds);

  // ISO string forced to +05:30 timezone
  return new Date(`${year}-${monthStr}-${dayStr}T${hourStr}:${minStr}:${secStr}+05:30`);
};

const getNextSunday8PM = () => {
  const now = new Date();
  const india = getIndiaDateParts(now);

  // Determine current day of week in India (0 = Sunday, 1 = Monday, etc.)
  const indiaDateObj = new Date(Date.UTC(india.year, india.month, india.day));
  const currentDay = indiaDateObj.getUTCDay();

  let daysUntilSunday = (7 - currentDay) % 7;

  // Use JavaScript Date object to handle month/year roll-over safely
  let targetDate = new Date(Date.UTC(india.year, india.month, india.day + daysUntilSunday));

  let targetISTDate = createISTDate(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth(),
    targetDate.getUTCDate(),
    20, 0, 0
  );

  // If today is Sunday and past 8:00 PM IST, move to next week's Sunday (+7 days)
  if (targetISTDate <= now) {
    targetDate.setUTCDate(targetDate.getUTCDate() + 7);
    targetISTDate = createISTDate(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate(),
      20, 0, 0
    );
  }

  return targetISTDate;
};

const getNextMonthEnd8PM = () => {
  const now = new Date();
  const india = getIndiaDateParts(now);

  // Get last day of current month in IST
  const lastDayOfCurrentMonth = new Date(Date.UTC(india.year, india.month + 1, 0)).getUTCDate();
  let currentMonthEnd = createISTDate(india.year, india.month, lastDayOfCurrentMonth, 20, 0, 0);

  // If already past 8:00 PM IST on the last day of this month, target next month's end
  if (currentMonthEnd <= now) {
    const lastDayOfNextMonth = new Date(Date.UTC(india.year, india.month + 2, 0)).getUTCDate();
    currentMonthEnd = createISTDate(india.year, india.month + 1, lastDayOfNextMonth, 20, 0, 0);
  }

  return currentMonthEnd;
};

export const startQueueRunner = () => {
  console.log("⏳ Mongo Queue Runner Started (Production Calendar Schedule Engine)...");

  setInterval(async () => {
    try {
      const now = new Date();

      if (!MONGODB_URI) {
        console.error("⚠️ Master Queue Runner: MONGODB_URI configuration string is completely missing.");
        return;
      }

      // 🔐 Standardized connection lifecycle execution abstraction wrapper
      await withDatabase(MONGODB_URI, async (db) => {
        
        // 🔍 Find pending solar report summaries ready to run right now
        const job = await db.collection("jobs_queue").findOneAndUpdate(
          {
            status: "pending",
            runAt: { $lte: now }
          },
          {
            $set: { status: "processing", lockedAt: now }
          },
          {
            returnDocument: "after"
          }
        );

        if (!job) return; 

        console.log(`🚀 Found active task to run: [${job.taskType}] (ID: ${job._id})`);

        // 🔀 TASK ROUTER
        switch (job.taskType) {
          case "WEEKLY_MASTER_SOLAR_SUMMARY":
            await processAllCustomersWeeklyJobs(db, job);
            break;

          case "MONTHLY_MASTER_SOLAR_SUMMARY": 
            await processAllCustomersMonthlyJobs(db, job);
            break;
          
          case "ZOHO_DEALS_SAFETY_SYNC":
            await handleZohoDealsSafetySync(db, job);
            break;  

          default:
            console.log(`⚠️ Unknown or retired task type encountered: ${job.taskType}`);
            await db.collection("jobs_queue").updateOne(
              { _id: job._id },
              { $set: { status: "failed", reason: "Unknown or retired task type" } }
            );
        }
      });

    } catch (error) {
      console.error("❌ Error in Master Queue Runner loop:", error.message);
    }
  }, 30000); // Polls database state safely every 30 seconds
};

export const processAllCustomersWeeklyJobs = async (db, masterJob) => {
  try {
    const users = await db.collection("userDetails").find({ 
      "UserInfo.role": "user",
      "PlatformInfo.devices.0": { $exists: true } 
    }).toArray();
    
    console.log(`📋 Found ${users.length} customer users with registered devices for Weekly Report.`);

    const now = new Date();
    const india = getIndiaDateParts(now);

    const indiaDateObj = new Date(Date.UTC(india.year, india.month, india.day));
    const currentDay = indiaDateObj.getUTCDay();
    const distanceToMonday = currentDay === 0 ? -6 : 1 - currentDay;

    const mondayDate = new Date(Date.UTC(india.year, india.month, india.day + distanceToMonday));
    const sundayDate = new Date(Date.UTC(mondayDate.getUTCFullYear(), mondayDate.getUTCMonth(), mondayDate.getUTCDate() + 6));

    const startTime = mondayDate.toISOString().split('T')[0]; 
    const endTime = sundayDate.toISOString().split('T')[0];

    for (const user of users) {
      const phoneNo = user._id;
      const stations = user.devicelist || [];
      
      let tokensToBroadcast = [];
      if (user.PlatformInfo && Array.isArray(user.PlatformInfo.devices)) {
        tokensToBroadcast = user.PlatformInfo.devices
          .map(d => d.fcmToken)
          .filter(token => token && token.trim().length > 0);
      }

      if (tokensToBroadcast.length === 0) continue;

      let totalUserWeeklyUnits = 0;
      let processedStationsCount = 0;
      let stationBreakdownText = ""; 

      for (const station of stations) {
        const stationId = station.id;
        const stationCustomName = station.name || `Station ${stationId}`;
        if (!stationId) continue;

        try {
          const data = await getSolarmanDataCore(db, user, stationId, 2, startTime, endTime);

          let stationUnits = 0;
          if (data && data.stationDataItems && Array.isArray(data.stationDataItems)) {
            data.stationDataItems.forEach(item => {
              if (item.generationValue) {
                stationUnits += Number(item.generationValue);
              }
            });
          }

          totalUserWeeklyUnits += stationUnits;
          processedStationsCount++;
          stationBreakdownText += `• ${stationCustomName}: ${stationUnits.toFixed(2)} Units\n`;

        } catch (stationError) {
          console.error(`   ⚠️ Failed to fetch weekly data for Station ${stationId}:`, stationError.message);
        }
      }

      if (processedStationsCount > 0) {
        totalUserWeeklyUnits = Number(totalUserWeeklyUnits.toFixed(2));
        const statusTitle = "☀️ Your Weekly Solar Report is Ready!";
        const finalNotificationBody = `Your weekly summary breakdown:\n${stationBreakdownText}Total Generation: ${totalUserWeeklyUnits} Units`;
        
        const messagesPayload = tokensToBroadcast.map(token => ({
          token: token.trim(),
          notification: { title: statusTitle, body: finalNotificationBody },
          android: {
            priority: "high",
            notification: {
              channelId: "weekly_summary_channel_v1",
              sound: "default",
              clickAction: "WEEKLY_SUMMARY_NOTIFICATION_ACTION",
            }
          },
          apns: {
            payload: {
              aps: { sound: "default", category: "WEEKLY_SUMMARY_NOTIFICATION_ACTION" }
            }
          },
          data: {
            type: "weekly_summary",
            title: statusTitle,
            body: finalNotificationBody,
            totalUnits: String(totalUserWeeklyUnits),
            show_actions: "false"
          }
        }));

        try {
          const batchResponse = await admin.messaging().sendEach(messagesPayload);
          
          for (let index = 0; index < batchResponse.responses.length; index++) {
            const singleResponse = batchResponse.responses[index];
            if (!singleResponse.success) {
              const errorInstance = singleResponse.error;
              const targetBadToken = tokensToBroadcast[index];

              if (errorInstance.code === 'messaging/registration-token-not-registered') {
                await db.collection("userDetails").updateOne(
                  { _id: phoneNo },
                  { $pull: { "PlatformInfo.devices": { fcmToken: targetBadToken } } }
                );
              }
            }
          }
        } catch (multicastErr) {
          console.error(`❌ Breakdown executing multi-device send operation:`, multicastErr.message);
        }
      }
    }

    // 🎯 CALENDAR UPDATE: Calculate exact upcoming Sunday at 8 PM IST
    const nextRunTime = getNextSunday8PM(); 

    await db.collection("jobs_queue").updateOne(
      { _id: masterJob._id },
      { $set: { status: "pending", runAt: nextRunTime, lockedAt: null, lastRunAt: new Date() } }
    );

    console.log(`✅ Weekly Master Loop finished. RESCHEDULED TARGET: ${nextRunTime.toString()}`);

  } catch (error) {
    console.error("❌ Critical breakdown in Weekly Master Loop processing:", error.message);
    await db.collection("jobs_queue").updateOne(
      { _id: masterJob._id },
      { $set: { status: "pending", lockedAt: null } }
    );
  }
};

export const processAllCustomersMonthlyJobs = async (db, masterJob) => {
  try {
    const users = await db.collection("userDetails").find({ 
      "UserInfo.role": "user",
      "PlatformInfo.devices.0": { $exists: true } 
    }).toArray();
    
    console.log(`📋 Found ${users.length} customer users with registered devices for Monthly Summary.`);

    const now = new Date();
    const india = getIndiaDateParts(now);

    const pad = (num) => String(num).padStart(2, '0');
    const startTime = `${india.year}-${pad(india.month + 1)}-01`; 
    const endTime = `${india.year}-${pad(india.month + 1)}-${pad(india.day)}`;

    for (const user of users) {
      const phoneNo = user._id;
      const stations = user.devicelist || [];
      
      let tokensToBroadcast = [];
      if (user.PlatformInfo && Array.isArray(user.PlatformInfo.devices)) {
        tokensToBroadcast = user.PlatformInfo.devices
          .map(d => d.fcmToken)
          .filter(token => token && token.trim().length > 0);
      }

      if (tokensToBroadcast.length === 0) continue;

      let totalUserMonthlyUnits = 0;
      let processedStationsCount = 0;
      let stationBreakdownText = ""; 

      for (const station of stations) {
        const stationId = station.id;
        const stationCustomName = station.name || `Station ${stationId}`;
        if (!stationId) continue;

        try {
          const data = await getSolarmanDataCore(db, user, stationId, 2, startTime, endTime);

          let stationUnits = 0;
          if (data && data.stationDataItems && Array.isArray(data.stationDataItems)) {
            data.stationDataItems.forEach(item => {
              if (item.generationValue) {
                stationUnits += Number(item.generationValue);
              }
            }); 
          }                     

          totalUserMonthlyUnits += stationUnits;
          processedStationsCount++;
          stationBreakdownText += `• ${stationCustomName}: ${stationUnits.toFixed(2)} Units\n`;

        } catch (stationError) {
          console.error(`   ⚠️ Failed to fetch monthly data for Station ${stationId}:`, stationError.message);
        }
      }

      if (processedStationsCount > 0) {
        totalUserMonthlyUnits = Number(totalUserMonthlyUnits.toFixed(2));
        const statusTitle = "☀️ Your Monthly Solar Summary is Ready!";
        const finalNotificationBody = `Your monthly summary breakdown:\n${stationBreakdownText}Total Generation: ${totalUserMonthlyUnits} Units`;
        
        const messagesPayload = tokensToBroadcast.map(token => ({
          token: token.trim(),
          notification: { title: statusTitle, body: finalNotificationBody },
          android: {
            priority: "high",
            notification: {
              channelId: "monthly_summary_channel_v1",
              sound: "default",
              clickAction: "MONTHLY_SUMMARY_NOTIFICATION_ACTION",
            }
          },
          apns: {
            payload: {
              aps: { sound: "default", category: "MONTHLY_SUMMARY_NOTIFICATION_ACTION" }
            }
          },
          data: {
            type: "monthly_summary",
            title: statusTitle,
            body: finalNotificationBody,
            totalUnits: String(totalUserMonthlyUnits),
            show_actions: "false"
          }
        }));

        try {
          const batchResponse = await admin.messaging().sendEach(messagesPayload);
          
          for (let index = 0; index < batchResponse.responses.length; index++) {
            const singleResponse = batchResponse.responses[index];
            if (!singleResponse.success) {
              const errorInstance = singleResponse.error;
              const targetBadToken = tokensToBroadcast[index];

              if (errorInstance.code === 'messaging/registration-token-not-registered') {
                await db.collection("userDetails").updateOne(
                  { _id: phoneNo },
                  { $pull: { "PlatformInfo.devices": { fcmToken: targetBadToken } } }
                );
              }
            }
          }
        } catch (multicastErr) {
          console.error(`❌ Breakdown executing multi-device monthly operation:`, multicastErr.message);
        }
      }
    }

    // 🎯 CALENDAR UPDATE: Calculate exact month-end date at 8 PM IST
    const nextRunTime = getNextMonthEnd8PM(); 

    await db.collection("jobs_queue").updateOne(
      { _id: masterJob._id },
      { $set: { status: "pending", runAt: nextRunTime, lockedAt: null, lastRunAt: new Date() } }
    );

    console.log(`✅ Monthly Master Loop finished. RESCHEDULED TARGET: ${nextRunTime.toString()}`);

  } catch (error) {
    console.error("❌ Critical breakdown in Monthly Master Loop processing:", error.message);
    await db.collection("jobs_queue").updateOne(
      { _id: masterJob._id },
      { $set: { status: "pending", lockedAt: null } }
    );
  }
};

// Phone field API name confirmed via Service Agents Name field metadata: "Phone".
const SERVICE_AGENT_PHONE_FIELD = "Phone";

// Module API name confirmed via test endpoint: "Service_Agents"
const SERVICE_AGENT_MODULE_API_NAME = "Service_Agents";

async function fetchServiceAgentPhone(agentId, headers) {
  if (!agentId) return null;
  try {
    const url = `https://www.zohoapis.in/crm/v8/${SERVICE_AGENT_MODULE_API_NAME}/${agentId}?fields=${SERVICE_AGENT_PHONE_FIELD}`;
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      console.log(`⚠️ Failed to fetch Service Agent ${agentId}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const record = data?.data?.[0];
    return record?.[SERVICE_AGENT_PHONE_FIELD] || null;
  } catch (err) {
    console.log(`⚠️ Error fetching Service Agent ${agentId}: ${err.message}`);
    return null;
  }
}

export async function handleZohoDealsSafetySync(db, task) {
  try {
    const isFirstRun = !task.lastRunAt;
    console.log(
      isFirstRun
        ? "🚀 [First Run Detected] Pulling ALL full live deals from Zoho CRM & mapping schema..."
        : "🔄 Running incremental 30-minute safety sync with Zoho CRM..."
    );

    const zohoToken = await getZohoAccessToken(db);

    const windowStart = new Date(Date.now() - 35 * 60 * 1000);
    const headers = {
      "Authorization": `Zoho-oauthtoken ${zohoToken}`
    };

    if (!isFirstRun) {
      headers["If-Modified-Since"] = windowStart.toUTCString();
    }

    let page = 1;
    let hasMoreRecords = true;
    let totalSynced = 0;

    // ✅ VERIFIED against Deals module field metadata + the actual webhook
    // "User defined Format" template used in Function 1. These are the
    // REAL Deals API names — Created_By is fetched as its own field
    // (it's Single Line text here, not a lookup), so no unbundling is
    // needed on this side; Zoho just gives us the raw fields directly.
    const fieldsToFetch = [
      "id",
      "Deal_Name",
      "Email",
      "Mobile",
      "WhatsApp_Number",
      "City",
      "State_Province",
      "Street_Address",
      "Latitude",
      "Longitude",
      "Referred_By",
      "Site_survey_Requested_Date_Time",
      "Created_By",
      "District",
      "Sub_District",
      "Google_Map_Location",
      "Zip_Postal_Code",
      "Country_Region",
      "Lead_Source",
      "Product_Type",
      "Order_Type",
      "Project_Type",
      "Project_Model",
      "Inverter_Connection_Type",
      "Inverter_Capacity",
      "Solar_Panel_Model",
      "Solar_Panel_Brand",
      "No_of_Panels",
      "Roof_Type",
      "Site_Survey_Status",
      "Service_Agents_Name" // Lookup field -> returns { id, name }, not a phone number
    ].join(",");

    while (hasMoreRecords) {
      const url = `https://www.zohoapis.in/crm/v8/Deals?fields=${fieldsToFetch}&per_page=200&page=${page}`;

      const zohoResponse = await fetch(url, { method: "GET", headers });

      if (zohoResponse.status === 204 || zohoResponse.status === 304) {
        if (page === 1) {
          console.log("ℹ️ No new or modified deals found in Zoho CRM.");
        }
        break;
      }

      if (!zohoResponse.ok) {
        const errText = await zohoResponse.text();
        throw new Error(`Zoho API failed on page ${page}: ${zohoResponse.status} - ${errText}`);
      }

      const zohoData = await zohoResponse.json();
      const deals = zohoData.data || [];

      if (deals.length === 0) break;

      for (const deal of deals) {
        const id = String(deal.id);
        const name = deal.Deal_Name || null;
        const email = deal.Email || null;
        const city = deal.City || null;
        const state = deal.State_Province || null;
        const street = deal.Street_Address || null;
        const latitude = deal.Latitude || null;
        const longitude = deal.Longitude || null;
        const referred_by = deal.Referred_By || null;
        const Site_Survey_Req_Date_Time = deal.Site_survey_Requested_Date_Time || null;

        // Direct fields — no bundling/unpacking needed here. The bundling
        // only exists on the Function 1 webhook side because of the
        // "User defined Format" template; the raw API gives these as
        // separate top-level fields already.
        const CreatedBy = deal.Created_By || null;
        const District = deal.District || null;
        const SubDistrict = deal.Sub_District || null;
        const GoogleLocation = deal.Google_Map_Location || null;
        const postalCode = deal.Zip_Postal_Code || null;
        const country = deal.Country_Region || null;
        const leadSource = deal.Lead_Source || null;
        const No_of_Panels = deal.No_of_Panels || null;
        const roofType = deal.Roof_Type || null;
        const siteSurveyStatus = deal.Site_Survey_Status || null; // mirrors Zoho directly

        // Technical specs
        const productType = deal.Product_Type || null;
        const orderType = deal.Order_Type || null;
        const projectType = deal.Project_Type || null;
        const projectModel = deal.Project_Model || null;
        const inverterConnectionType = deal.Inverter_Connection_Type || null;
        const inverterCapacity = deal.Inverter_Capacity || null;
        const solarPanel_Model = deal.Solar_Panel_Model || null;
        const solarPanelBrand = deal.Solar_Panel_Brand || null;

        // Service_Agents_Name is a Lookup field -> Zoho returns { id, name }.
        // Phone lives on the related Service Agents Name module record, so
        // we resolve it via fetchServiceAgentPhone() below (see the
        // SERVICE_AGENT_MODULE_API_NAME TODO at the top of this file).
        const serviceAgentId = deal.Service_Agents_Name?.id || null;
        const serviceAgentName = deal.Service_Agents_Name?.name || null;

        let surveyorNumber = null;
        const rawAgentPhone = await fetchServiceAgentPhone(serviceAgentId, headers);
        if (rawAgentPhone) {
          surveyorNumber = String(rawAgentPhone).replace(/\D/g, '');
          if (surveyorNumber.length === 12 && surveyorNumber.startsWith('91')) {
            surveyorNumber = surveyorNumber.substring(2);
          }
        }

        let cleanMobile = deal.Mobile ? String(deal.Mobile).replace(/\D/g, '') : null;
        if (cleanMobile && cleanMobile.length === 12 && cleanMobile.startsWith('91')) {
          cleanMobile = cleanMobile.substring(2);
        }

        let cleanWhatsappNo = deal.WhatsApp_Number || null;
        if (cleanWhatsappNo) {
          cleanWhatsappNo = String(cleanWhatsappNo).replace(/\D/g, '');
          if (cleanWhatsappNo.length === 12 && cleanWhatsappNo.startsWith('91')) {
            cleanWhatsappNo = cleanWhatsappNo.substring(2);
          }
        }

        // 🎯 isSurveyorAssigned still controls assignedTo/assignedAt (do we
        // have a resolvable surveyor phone), but siteSurveyStatus now
        // mirrors Zoho's real field directly instead of being guessed.
        const isSurveyorAssigned = Boolean(surveyorNumber && surveyorNumber.length >= 10);

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
          referred_by: referred_by,
          Site_Survey_Req_Date_Time: Site_Survey_Req_Date_Time,
          siteSurveyStatus: siteSurveyStatus,
          leadSource: leadSource,
          state: state,
          postalCode: postalCode,
          country: country,
          CreatedBy: CreatedBy,
          District: District,
          ServiceAgentName: serviceAgentName,
          SubDistrict: SubDistrict,
          GoogleLocation: GoogleLocation,

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
          updatedAt: new Date()
        };

        if (isSurveyorAssigned) {
          fullDealPayload.assignedTo = surveyorNumber;
          fullDealPayload.assignedAt = new Date().toISOString();
        }

        // Build $setOnInsert without any field already present in $set —
        // Mongo rejects an update where the same path appears in both.
        // siteSurveyStatus is always in $set now (mirrors Zoho directly),
        // so it must never appear here.
        const setOnInsert = {
          assignedBy: null,
          createdAt: new Date(),
          rejections: []
        };
        if (!isSurveyorAssigned) {
          setOnInsert.assignedTo = null;
          setOnInsert.assignedAt = null;
        }

        await db.collection("deals").updateOne(
          { deal_id: id },
          {
            $set: fullDealPayload,
            $setOnInsert: setOnInsert
          },
          { upsert: true }
        );
      }

      totalSynced += deals.length;
      console.log(`📥 Page ${page}: Synced/Updated ${deals.length} deals (Total so far: ${totalSynced})`);

      hasMoreRecords = zohoData.info?.more_records === true;
      page++;
    }

    console.log(`✅ Deals safety sync finished. Total processed: ${totalSynced}`);
    await rescheduleTask(db, task._id);

  } catch (error) {
    console.error("❌ Error in handleZohoDealsSafetySync:", error.message);

    // Unlock and retry in 5 minutes
    await db.collection("tasks").updateOne(
      { _id: task._id },
      {
        $set: {
          status: "pending",
          lockedAt: null,
          runAt: new Date(Date.now() + 5 * 60 * 1000)
        }
      }
    );
  }
}

async function rescheduleTask(db, taskId) {
  const nextRun = new Date(Date.now() + 30 * 60 * 1000);
  await db.collection("tasks").updateOne(
    { _id: taskId },
    {
      $set: {
        status: "pending",
        lockedAt: null,
        lastRunAt: new Date(),
        runAt: nextRun
      }
    }
  );
  console.log(`⏰ Next safety sync scheduled at: ${nextRun.toISOString()}`);
}