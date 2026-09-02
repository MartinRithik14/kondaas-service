import { withDatabase, Binary, ObjectId, getSystemKeys } from '../utils/config.js';
import { generatePDF } from '../utils/pdfGenerator.js';
import { getZohoAccessToken } from '../utils/zohoAuth.js';
import { uploadToZohoWorkDrive, uploadSurveyorAttendancePhoto, getOrCreateLeadsSEFolder,createZohoPublicDownloadUrl } from '../utils/uploadToZohoWorkDrive.js';
import { getInvoiceTemplate, getSurveyReportTemplate } from '../templates/invoiceTemplate.js';
import path from 'path';
import fs from 'fs';

const MONGODB_URI = process.env.MONGODB_URI;

const processWhatsAppNotification = async (notificationId) => {
  try {
    await withDatabase(MONGODB_URI, async (db) => {
      const keys = await getSystemKeys(db);
      const { apiUrl: BASE_URL, apiKey: API_KEY } = keys.whatsapp;

      const notification = await db.collection("notifications").findOneAndUpdate(
        { _id: notificationId, status: "pending" },
        { $set: { status: "processing", startedAt: new Date() } },
        { returnDocument: 'after' }
      );

      if (!notification) return;

      const type = notification.contentType;
      const formattedNumber = `91${notification.to}`;
      const contentString = notification.content.buffer.toString('utf8');

      // 🔀 DYNAMIC ACTION ROUTER
      let action;
      let payload = { number: formattedNumber };

      if (type === "text") {
        action = "sendText/petchirajan";
        payload.text = contentString;
      } else if (type === "poll") {
        action = "sendPoll/petchirajan";
        payload.name = contentString; // Message title of the Poll
        payload.selectableCount = 1;
        payload.values = ["1", "2", "3", "4", "5"]; // Options array
      } else {
        action = "sendMedia/petchirajan";
        payload = {
          ...payload,
          mediatype: "document",
          media: contentString,
          fileName: "Kondaas_Invoice.pdf",
          caption: notification.caption || "Thank you for choosing Kondaas!"
        };
      }

      const response = await fetch(`${BASE_URL}${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": API_KEY },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        await db.collection("notifications").updateOne(
          { _id: notificationId },
          { $set: { status: "completed", completedAt: new Date() } }
        );
      } else {
        const errorData = await response.text();
        throw new Error(`API Error ${response.status}: ${errorData}`);
      }
    });
  } catch (err) {
    console.error("❌ WhatsApp Task Failed:", err.message);
    await withDatabase(MONGODB_URI, async (db) => {
      await db.collection("notifications").updateOne(
        { _id: notificationId },
        { $set: { status: "failed" }, $inc: { retryCount: 1 } }
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

      // 3. Update MongoDB (using $set with our dynamic fields object)
      const updatedDeal = await db.collection('deals').findOneAndUpdate(
        {
          whatsappNo: mobile.trim(),
          siteSurveyStatus: "completed" // 🎯 Safety guardrail matching your business logic
        },
        {
          $set: updateFields
        },
        { returnDocument: 'after' } // Grab the latest fields so we can send the complete state to Zoho
      );

      // 4. Handle if no matching record is found in your database
      if (!updatedDeal) {
        return c.json({
          success: false,
          message: "No active completed survey record found matching this mobile number.",
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

export const triggerScenarioNotification = async (c) => {
  try {
    const { deal_id, surveyorNumber, customerMobile, name, scenarioType, eta, mapsUrl, state } = await c.req.json();

    let cleanedCustomerMobile = customerMobile ? String(customerMobile).replace(/\D/g, '') : null;
    if (cleanedCustomerMobile && cleanedCustomerMobile.length === 12 && cleanedCustomerMobile.startsWith('91')) {
      cleanedCustomerMobile = cleanedCustomerMobile.substring(2);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const customerName = name;
      const whatsappTo = cleanedCustomerMobile;

      const messages = {
        1: `Hello ${customerName}, your Kondaas technician has started. Arrival in ${eta || 'soon'} min. Contact: ${surveyorNumber}.${mapsUrl ? `\n\n📍 Track Location: ${mapsUrl}` : ''}`,
        2: `Hello ${customerName}, your technician is just 300 meters away!`,
        3: `Hello ${customerName}, your technician has arrived.`,
        4: `Hello ${customerName}, your technician has completed the work. Thank you for choosing Kondaas! and kindly give rating.`
      };

      // --- STEP 1: ALWAYS SEND THE TEXT MESSAGE FIRST ---
      const textResult = await db.collection("notifications").insertOne({
        from: "Kondaas_System",
        to: whatsappTo,
        mode: "whatsapp",
        content: new Binary(Buffer.from(messages[scenarioType], 'utf8')),
        contentType: "text",
        status: "pending",
        createdAt: new Date()
      });
      processWhatsAppNotification(textResult.insertedId).catch(err => console.error(err));

      // --- STEP 2: SCENARIO 4 HEAVY BACKGROUND TREE & POLL EXECUTION ---
      if (Number(scenarioType) === 4) {
        
        // Background PDF & Sync compilation block remains isolated here
        (async () => {
          try {
            if (!deal_id) {
              console.error("❌ Document Generation Cancelled: Missing 'deal_id' in payload request.");
              return;
            }

            console.log(`📄 Fetching forms record for clean mobile: ${cleanedCustomerMobile}...`);


            //Chnage this whatsapp number to deal id //

            const formData = await db.collection("forms").findOne({ deal_id: deal_id || deal_id  });

            if (!formData) {
              console.error(`❌ Document Generation Cancelled: No form entry found for mobile: ${deal_id}`);
              return;
            }

            formData.deal_id = deal_id;
            
            formData.Site_Survey_Requested_Date_Time = new Date().toISOString();

            console.log("🛠️ Compiling Technical Survey Report PDF...");
            const surveyFileName = `Survey_Report_${deal_id}.pdf`;
            const surveyFilePath = path.join(process.cwd(), surveyFileName);

            const surveyHtml = getSurveyReportTemplate(formData);
            await generatePDF(surveyHtml, surveyFilePath);

            console.log(`🔄 Resolving Zoho WorkDrive "Survey" Folder for Deal ID [${deal_id}] in [${state || 'Default'}]...`);
            const targetSurveyFolderId = await getOrCreateLeadsSEFolder(deal_id, "Survey", state);

            const surveyUploadResult = await uploadToZohoWorkDrive(surveyFilePath, surveyFileName, targetSurveyFolderId);
            console.log(`✅ Survey Report synced successfully to WorkDrive: ${surveyUploadResult.url}`);

            fs.unlink(surveyFilePath, (err) => {
              if (err) console.error("❌ Error deleting local temporary survey PDF:", err.message);
            });

            try {
              console.log(`📡 Attaching survey report link to Zoho CRM Deals for ID: ${deal_id}`);
              const zohoToken = await getZohoAccessToken(db);

              const linkPayload = {
                id: deal_id,
                Site_Survey_form: String(surveyUploadResult.url).trim()
              };

              const crmResponse = await fetch(`https://www.zohoapis.in/crm/v8/Deals/${deal_id}`, {
                method: "PUT",
                headers: {
                  "Authorization": `Zoho-oauthtoken ${zohoToken}`,
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

            console.log(`🔄 Resolving Zoho WorkDrive "Invoice" Folder for Deal ID [${deal_id}] in [${state || 'Default'}]...`);
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

            // 📄 Dispatch Invoice PDF Notification
            const pdfResult = await db.collection("notifications").insertOne({
              from: "Kondaas_System",
              to: whatsappTo,
              mode: "whatsapp",
              content: new Binary(Buffer.from(finalShareableLink.trim(), 'utf8')),
              contentType: "pdf",
              caption: "Here is your formal invoice. Thank you!",
              status: "pending",
              createdAt: new Date()
            });
            //processWhatsAppNotification(pdfResult.insertedId).catch(err => console.error(err));//

            // 📊 🎯 MOVED TO THE LAST STEP: Fire interactive satisfaction rating poll safely here!
            console.log("📊 Sending customer satisfaction rating poll feedback interface...");
            const pollResult = await db.collection("notifications").insertOne({
              from: "Kondaas_System",
              to: whatsappTo,
              mode: "whatsapp",
              content: new Binary(Buffer.from("Rate our service", 'utf8')),
              contentType: "poll",
              status: "pending",
              createdAt: new Date()
            });
            processWhatsAppNotification(pollResult.insertedId).catch(err => console.error(err));

          } catch (pdfErr) {
            console.error("❌ Background PDF Document Tree Generation Failed:", pdfErr);
          }
        })();
      }

      return c.json({
        message: `Scenario ${scenarioType} flow executed.`,
        id: textResult.insertedId
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