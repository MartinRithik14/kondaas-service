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
    const rawBody = await c.req.json();

    // Forward the exact payload to the AWS machine
    const awsResponse = await fetch("https://board.trisentrix.com/notification/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rawBody),
    });

    const responseData = await awsResponse.json().catch(() => ({}));

    return c.json(responseData, awsResponse.status);
  } catch (err) {
    console.error("❌ Mission Failed:", err.message);
    return c.json({ error: err.message }, 500);
  }
};

export const triggerScenarioNotification = async (c) => {
  try {
    const rawBody = await c.req.json();

    // Forward the exact payload to the AWS machine
    const awsResponse = await fetch("https://board.trisentrix.com/notification/trigger", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rawBody),
    });

    const responseData = await awsResponse.json().catch(() => ({}));

    return c.json(responseData, awsResponse.status);
  } catch (err) {
    console.error("❌ Mission Failed:", err.message);
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