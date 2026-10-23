import { withDatabase, Binary, ObjectId, getSystemKeys } from '../utils/config.js';
import { generatePDF } from '../utils/pdfGenerator.js';
import { getZohoAccessToken } from '../utils/zohoAuth.js';
import { uploadToZohoWorkDrive, uploadSurveyorAttendancePhoto, getOrCreateLeadsSEFolder,createZohoPublicDownloadUrl } from '../utils/uploadToZohoWorkDrive.js';
import { getInvoiceTemplate, getSurveyReportTemplate } from '../templates/invoiceTemplate.js';
import path from 'path';
import fs from 'fs';

const MONGODB_URI = process.env.MONGODB_URI;

//Interakt API for WhatsApp notifications
const resolveInteraktTemplate = (notification, contentString) => {
  // 1. If explicitly queued with Interakt metadata:
  if (notification.templateName) {
    return {
      templateName: notification.templateName,
      bodyValues: notification.bodyValues || []
    };
  }

  // 2. Fallback resolution for poll ratings:
  if (notification.contentType === "poll") {
    // If it's a delivery poll vs surveyor poll:
    const isDelivery = notification.context === "delivery" || contentString.toLowerCase().includes("delivery");
    return {
      templateName: isDelivery ? "delivery_feedback_rating" : "surveyor_feedback_rating",
      bodyValues: [notification.customerName || "Customer"]
    };
  }

  // 3. Optional: Map known text patterns if templateName was not attached at queue time
  return null;
};


const sendViaInterakt = async ({ interaktConfig, to, templateName, bodyValues = [], languageCode = "en" }) => {
  const url = interaktConfig.apiUrl || "https://api.interakt.ai/v1/public/message/";
  const payload = {
    countryCode: "+91",
    phoneNumber: String(to).replace(/^\+?91/, ""),
    type: "Template",
    template: {
      name: templateName,
      
      languageCode: languageCode, // Try "en_US" if "en" fails after sync
      bodyValues
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${interaktConfig.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Interakt API Error ${res.status}: ${errText}`);
  }

  return await res.json();
};



export const processWhatsAppNotification = async (notificationId) => {
  try {
    await withDatabase(MONGODB_URI, async (db) => {
      const keys = await getSystemKeys(db);

      if (!keys.interakt || !keys.interakt.apiKey) {
        throw new Error("Interakt credentials are not configured in system_keys.");
      }

      const notification = await db.collection("notifications").findOneAndUpdate(
        { _id: notificationId, status: "pending" },
        { $set: { status: "processing", startedAt: new Date() } },
        { returnDocument: "after" }
      );

      if (!notification) return;

      const contentString = notification.content?.buffer 
        ? notification.content.buffer.toString("utf8") 
        : (notification.content || "");

      const templateInfo = resolveInteraktTemplate(notification, contentString);
      if (!templateInfo) {
        throw new Error(`No matching Interakt template could be resolved for notification ${notificationId}`);
      }

      console.log(`📡 Sending WhatsApp via Interakt template: ${templateInfo.templateName}...`);
      await sendViaInterakt({
        interaktConfig: keys.interakt,
        to: notification.to,
        templateName: templateInfo.templateName,
        bodyValues: templateInfo.bodyValues,
        ...(templateInfo.headerValues && { headerValues: templateInfo.headerValues })
      });

      // --- RECORD SUCCESS ---
      await db.collection("notifications").updateOne(
        { _id: notificationId },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            providerUsed: "interakt"
          }
        }
      );
    });
  } catch (err) {
    console.error("❌ WhatsApp Task Failed Completely:", err.message);
    await withDatabase(MONGODB_URI, async (db) => {
      await db.collection("notifications").updateOne(
        { _id: notificationId },
        { $set: { status: "failed", lastError: err.message }, $inc: { retryCount: 1 } }
      );
    });
  }
};

export const saveWhatsAppRating = async (c) => {
  try {
    // 1. Parse incoming body data via Hono's native parser
    const body = await c.req.json();
    const { mobile, rating, feedback } = body;

    // 2. Structural data validation check
    // Mobile is mandatory, and we must receive at least a rating OR feedback to do an update
    if (!mobile || (rating === undefined && feedback === undefined)) {
      return c.json({
        success: false,
        message: "Missing required fields: mobile and either rating or feedback are mandatory.",
      }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {

      // 🛠️ DYNAMIC UPDATE PAYLOAD: Only update what is provided to prevent overwriting existing data
      const updateFields = {
        ratingReceivedAt: new Date()
      };

      if (rating !== undefined && rating !== null) {
        updateFields.rating = String(rating).trim();
      }

      if (feedback !== undefined && feedback !== null) {
        updateFields.feedback = String(feedback).trim();
      }

   
      const updatedDeal = await db.collection('deals').findOneAndUpdate(
        {
          whatsappNo: mobile.trim(),
          siteSurveyStatus: { $in: ["Completed", "completed"] },
          rating: { $exists: false } // excludes already-rated deals from earlier visits
        },
        {
          $set: updateFields
        },
        {
          sort: { completedAt: -1 }, // if multiple unrated completed deals exist, always take the newest
          returnDocument: 'after'
        }
      );

      // 4. Handle if no matching record is found in your database
      if (!updatedDeal) {
        return c.json({
          success: false,
          message: "No active completed survey record found matching this mobile number (or it may have already been rated).",
        }, 404);
      }

      // 💥 ZOHO CRM INTEGRATION LAYER 💥
      const zohoDealId = updatedDeal.deal_id;

      if (!zohoDealId) {
        console.warn(`⚠️ saved locally, but skipping Zoho update because deal_id is missing for mobile: ${mobile}`);
        return c.json({
          success: true,
          message: "Rating saved locally, but no Zoho deal_id linked to this record.",
        }, 200);
      }

      try {
        // 🔐 Grab active authorization credentials dynamically out of RAM / config collection
        const zohoToken = await getZohoAccessToken(db);

        console.log(`📡 Syncing fields to Zoho CRM for Deal ID: ${zohoDealId}...`);

        // 📝 Pull the combined current state directly from the updated database object 
        // This ensures Zoho always gets both fields, even if they arrived across separate requests!
        const zohoPayload = {
          data: [
            {
              id: zohoDealId,
              Rating: updatedDeal.rating || "",
              Site_Survey_Remarks: updatedDeal.feedback || ""
            }
          ]
        };

        const zohoResponse = await fetch(`https://www.zohoapis.in/crm/v8/Deals`, {
          method: "PUT",
          headers: {
            "Authorization": `Zoho-oauthtoken ${zohoToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(zohoPayload)
        });

        if (!zohoResponse.ok) {
          const errorText = await zohoResponse.text();
          console.error(`❌ Zoho API rating sync failed for Deal ${zohoDealId}:`, errorText);
          return c.json({
            success: true,
            message: "Rating saved locally, but failed to sync with Zoho CRM.",
            deal_id: zohoDealId
          }, 200);
        }

        const zohoResult = await zohoResponse.json();
        console.log(`✅ Zoho CRM Sync Successful for Deal ${zohoDealId}:`, JSON.stringify(zohoResult?.data?.[0]?.status));

      } catch (zohoError) {
        console.error("❌ Exception inside Zoho CRM update transaction block:", zohoError.message);
      }

      // 5. Final Success Response
      return c.json({
        success: true,
        message: "Rating and feedback successfully processed and synchronized with Zoho CRM.",
        deal_id: zohoDealId
      }, 200);
    });

  } catch (error) {
    console.error("❌ Error inside saveWhatsAppRating Hono controller:", error.message);
    return c.json({
      success: false,
      message: "Internal Server Error while saving customer feedback.",
    }, 500);
  }
};

const toPreviewUrl = (url, fileId) => {
  if (!url && fileId) return `https://workdrive.zoho.in/file/${fileId}`;
  if (typeof url === "string" && url.includes("/api/v1/download/")) {
    const extractedId = url.split("/download/")[1];
    return `https://workdrive.zoho.in/file/${extractedId}`;
  }
  return url || "";
};

const formatZohoUrl = (url) => {
  if (!url) return "";
  return String(url).trim();
};

export const triggerScenarioNotification = async (c) => {
  try {
    const { deal_id, surveyorNumber, customerMobile, name, scenarioType, eta, state } = await c.req.json();

    const numericScenario = Number(scenarioType);

    // Guard against Scenario 2 or unknown scenarios
    if (![1, 3, 4].includes(numericScenario)) {
      return c.json({ error: `Invalid scenarioType: ${scenarioType}. Supported scenarios are 1, 3, and 4.` }, 400);
    }

    let cleanedCustomerMobile = customerMobile ? String(customerMobile).replace(/\D/g, "") : null;
    if (cleanedCustomerMobile && cleanedCustomerMobile.length === 12 && cleanedCustomerMobile.startsWith("91")) {
      cleanedCustomerMobile = cleanedCustomerMobile.substring(2);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const customerName = name || "Customer";
      const whatsappTo = cleanedCustomerMobile;

      // 1. Text message templates for Evolution API (1 and 3 only; 4 is handled via final poll)
      const messages = {
        1: `Hello ${customerName}, your Kondaas technician has started. Arrival in ${eta || "soon"} min. Contact: ${surveyorNumber}.`,
        3: `Hello ${customerName}, your technician has arrived.`
      };

      // 2. Interakt fallback metadata mappings (1 and 3 only)
      const interaktTemplates = {
        1: {
          templateName: "surveyor_started",
          bodyValues: [String(customerName), String(eta || "30"), String(surveyorNumber || "")]
        },
        3: {
          templateName: "surveyor_arrived",
          bodyValues: [String(customerName)]
        }
      };

      let textNotificationId = null;

      // --- STEP 1: SEND IMMEDIATE TEXT NOTIFICATION ONLY FOR SCENARIOS 1 AND 3 ---
      if (numericScenario === 1 || numericScenario === 3) {
        const fallbackMeta = interaktTemplates[numericScenario] || {};
        const textResult = await db.collection("notifications").insertOne({
          from: "Kondaas_System",
          to: whatsappTo,
          mode: "whatsapp",
          content: new Binary(Buffer.from(messages[numericScenario] || "", "utf8")),
          contentType: "text",
          templateName: fallbackMeta.templateName,
          bodyValues: fallbackMeta.bodyValues,
          status: "pending",
          createdAt: new Date()
        });

        textNotificationId = textResult.insertedId;
        processWhatsAppNotification(textNotificationId).catch((err) => console.error(err));
      }

      // --- STEP 2: SCENARIO 4 HEAVY BACKGROUND TREE & SOLE POLL EXECUTION ---
      if (numericScenario === 4) {
        (async () => {
          try {
            if (!deal_id) {
              console.error("❌ Document Generation Cancelled: Missing 'deal_id' in payload request.");
              return;
            }

            console.log(`📄 Fetching forms record for clean mobile: ${cleanedCustomerMobile}...`);

            const formData = await db.collection("forms").findOne({ deal_id: deal_id });

            if (!formData) {
              console.error(`❌ Document Generation Cancelled: No form entry found for deal: ${deal_id}`);
              return;
            }

            formData.deal_id = deal_id;
            formData.Site_Survey_Requested_Date_Time = new Date().toISOString();

            console.log("🛠️ Compiling Technical Survey Report PDF...");
            const surveyFileName = `Survey_Report_${deal_id}.pdf`;
            const surveyFilePath = path.join(process.cwd(), surveyFileName);

            const surveyHtml = getSurveyReportTemplate(formData);
            await generatePDF(surveyHtml, surveyFilePath);

            console.log(`🔄 Resolving Zoho WorkDrive "Survey" Folder for Deal ID [${deal_id}] in [${state || "Default"}]...`);
            const targetSurveyFolderId = await getOrCreateLeadsSEFolder(deal_id, "Survey", state);

            const surveyUploadResult = await uploadToZohoWorkDrive(surveyFilePath, surveyFileName, targetSurveyFolderId);
            console.log(`✅ Survey Report synced successfully to WorkDrive: ${surveyUploadResult.url}`);

            fs.unlink(surveyFilePath, (err) => {
              if (err) console.error("❌ Error deleting local temporary survey PDF:", err.message);
            });

            try {
              console.log(`📡 Attaching survey report link to Zoho CRM Deals for ID: ${deal_id}`);
              const zohoToken = await getZohoAccessToken(db);

              const surveyPreviewUrl = surveyUploadResult?.fileId
                ? `https://workdrive.zoho.in/file/${surveyUploadResult.fileId}`
                : toPreviewUrl(surveyUploadResult?.url, surveyUploadResult?.fileId);

              const linkPayload = {
                id: deal_id,
                Site_Survey_form: formatZohoUrl(surveyPreviewUrl)
              };

              const crmResponse = await fetch(`https://www.zohoapis.in/crm/v8/Deals/${deal_id}`, {
                method: "PUT",
                headers: {
                  Authorization: `Zoho-oauthtoken ${zohoToken}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ data: [linkPayload] })
              });

              if (!crmResponse.ok) {
                const errDetails = await crmResponse.text();
                console.error("❌ Zoho CRM Link Attachment Blocked:", errDetails);
              } else {
                console.log(`✅ Site Survey WorkDrive link updated on Zoho record field.`);
              }
            } catch (crmErr) {
              console.error("⚠️ Non-blocking warning: CRM link attachment dropped:", crmErr.message);
            }

            console.log("💰 Compiling Commercial Invoice PDF...");
            const invoiceFileName = `${deal_id}.pdf`;
            const invoiceFilePath = path.join(process.cwd(), invoiceFileName);

            const invoiceHtml = getInvoiceTemplate(formData);
            await generatePDF(invoiceHtml, invoiceFilePath);

            console.log(`🔄 Resolving Zoho WorkDrive "Invoice" Folder for Deal ID [${deal_id}] in [${state || "Default"}]...`);
            const targetInvoiceFolderId = await getOrCreateLeadsSEFolder(deal_id, "Invoice", state);

            const invoiceUploadResult = await uploadToZohoWorkDrive(invoiceFilePath, invoiceFileName, targetInvoiceFolderId);
            console.log(`✅ Invoice synced successfully to Zoho: ${invoiceUploadResult.url}`);

            console.log("🔗 Generating unauthenticated public direct-download URL from Zoho links engine...");
            const publicDownloadUrl = await createZohoPublicDownloadUrl(db, invoiceUploadResult.fileId);

            const finalShareableLink = publicDownloadUrl || invoiceUploadResult.url;
            console.log(`🚀 Final Customer Share Link configured: ${finalShareableLink}`);

            fs.unlink(invoiceFilePath, (err) => {
              if (err) console.error("❌ Error deleting local temporary invoice PDF:", err.message);
            });

            // 📊 🎯 Single rating poll delivered once background PDF work completes
            console.log("📊 Sending customer satisfaction rating poll feedback interface...");
            const pollResult = await db.collection("notifications").insertOne({
              from: "Kondaas_System",
              to: whatsappTo,
              mode: "whatsapp",
              content: new Binary(Buffer.from("Rate our service", "utf8")),
              contentType: "poll",
              templateName: "surveyor_completed_rating_d4",
              bodyValues: [String(customerName)],
              status: "pending",
              createdAt: new Date()
            });

            processWhatsAppNotification(pollResult.insertedId).catch((err) => console.error(err));

          } catch (pdfErr) {
            console.error("❌ Background PDF Document Tree Generation Failed:", pdfErr);
          }
        })();
      }

      return c.json({
        message: `Scenario ${numericScenario} flow executed.`,
        id: textNotificationId
      });
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};

//attendance photo upload handler
export const handleSurveyorPhotoUpload = async (c) => {
  let temporaryFilePath = null;

  try {
    const body = await c.req.parseBody();

    const photoFile = body['photo'];
    const phoneNo = body['phoneNo'];
    const time = body['time'];

    if (!photoFile || !phoneNo || !time) {
      return c.json({
        success: false,
        message: "Validation Error: Missing required multipart fields: 'photo', 'phoneNo', or 'time'."
      }, 400);
    }

    console.log(`📸 Processing incoming attendance photo from Surveyor: ${phoneNo} at ${time}...`);

    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const arrayBuffer = await photoFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const fileExt = path.extname(photoFile.name) || '.jpg';

    temporaryFilePath = path.join(uploadDir, `temp_${Date.now()}_${photoFile.name}`);
    fs.writeFileSync(temporaryFilePath, buffer);

    const workDriveUrl = await uploadSurveyorAttendancePhoto(temporaryFilePath, phoneNo, time, fileExt);

    return c.json({
      success: true,
      message: "Attendance photo synced to Zoho WorkDrive attendance folder successfully.",
      url: workDriveUrl
    }, 200);

  } catch (error) {
    console.error("❌ Surveyor Attendance Photo Route Pipeline Failed:", error.message);
    return c.json({
      success: false,
      message: "Internal server crash during WorkDrive attendance photo sync operation.",
      error: error.message
    }, 500);

  } finally {
    if (temporaryFilePath && fs.existsSync(temporaryFilePath)) {
      try {
        fs.unlinkSync(temporaryFilePath);
        console.log(`🗑️ Cleaned up temporary local workspace photo asset: ${temporaryFilePath}`);
      } catch (err) {
        console.error("⚠️ Failed to remove temporary upload photo file:", err.message);
      }
    }
  }
};
//for leads dynamic folder with yyyy-mm-dd date structure in zoho tree layout



export const addNotification = async (c) => {
  try {
    const body = await c.req.json();
    const { to, mode, content, contentType } = body;

    if (!to || !mode || !content || !contentType) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    const contentBinary = new Binary(Buffer.from(content, 'utf8'));

    const notificationId = await withDatabase(MONGODB_URI, async (db) => {
      const result = await db.collection("notifications").insertOne({
        ...body,
        content: contentBinary,
        status: "pending",
        createdAt: new Date()
      });
      return result.insertedId;
    });

    if (mode === "whatsapp") {
      processWhatsAppNotification(notificationId).catch(err =>
        console.error("Background WhatsApp Error:", err)
      );
    }

    return c.json({ message: "Notification queued", id: notificationId }, 201);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};

export const updateNotification = async (c) => {
  try {
    const { id, status, retryCount } = await c.req.json();
    if (!id) return c.json({ error: "id is required!" }, 400);

    const updateResult = await withDatabase(MONGODB_URI, async (db) => {
      return await db.collection("notifications").updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, retryCount, updatedAt: new Date() } }
      );
    });

    if (updateResult.matchedCount === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ message: "Updated successfully" });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};