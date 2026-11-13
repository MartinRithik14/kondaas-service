import { withDatabase } from '../utils/config.js';


const MONGODB_URI = process.env.MONGODB_URI;

export const getDealInfo = async (c) => {
    try {
        // 1. Extract query parameters from the frontend URL request (default to Page 1)
        const page = parseInt(c.req.query("page") || "1", 10);
        const limit = parseInt(c.req.query("limit") || "20", 10);

        // Safeguard against invalid pagination parameters
        const activePage = page < 1 ? 1 : page;
        const activeLimit = limit < 1 ? 20 : limit;

        // 2. Compute the exact skip offset using the pagination formula
        const skipValue = (activePage - 1) * activeLimit;

        return await withDatabase(MONGODB_URI, async (db) => {
            const formsCollection = db.collection("forms");

            // 3. Run parallel lookups: fetch data (with projection filtering) and count totals concurrently
            const [formsData, totalForms] = await Promise.all([
                formsCollection
                    .find({})
                    .sort({ _id: -1 })
                    .skip(skipValue)
                    .limit(activeLimit)
                    .project({
                        // 🚫 Exclude heavy image data and long strings
                        Site_Engineer_Signature: 0,
                        Customer_Confirmation_Signature: 0,
                        ebBillPhotos: 0,
                        sitePhotos: 0
                    })
                    .toArray(),
                formsCollection.countDocuments({})
            ]);

            // 4. Send back the clean, lightweight response with pagination metadata
            return c.json({
                success: true,
                data: formsData,
                pagination: {
                    totalItems: totalForms,
                    currentPage: activePage,
                    limit: activeLimit,
                    totalPages: Math.ceil(totalForms / activeLimit),
                    hasNextPage: skipValue + formsData.length < totalForms,
                    hasPrevPage: activePage > 1
                }
            }, 200);
        });

    } catch (err) {
        console.error("❌ Fetching Paginated Forms Error Exception:", err.message);
        return c.json({ error: "Failed to fetch form details repository" }, 500);
    }
};

export const assignLogisticsMember = async (c) => {
    try {
        // 1. Extract payload from the request body
        const body = await c.req.json();
        const { deal_id, products_info, mobile,address } = body;

        // Validation guard clause
        if (!deal_id || !mobile) {
            return c.json({ success: false, error: "Missing deal_id or mobile number" }, 400);
        }

        return await withDatabase(MONGODB_URI, async (db) => {
            // 2. Upsert the tracking state inside 'logistics_deals'
            await db.collection("logistics_deals").updateOne(
                { deal_id: deal_id },
                {
                    $set: {
                        deal_id,
                        products_info: Array.isArray(products_info) ? products_info : [], // Ensures it saves as a clean array ["2 X Solar Panels", "1 X Inverter"]
                        mobile,
                        address,
                        status: "pending",
                        assignedAt: new Date()
                    }
                },
                { upsert: true }
            );

            // 3. Look up the profile inside 'userdetails' using the mobile variable
            const userProfile = await db.collection("userdetails").findOne({
                "UserInfo.phoneNo": mobile,
                "UserInfo.role": "logistic"
            });

            if (!userProfile) {
                return c.json({ success: true, message: "Assignment saved, but logistics member profile not found." }, 200);
            }

            // 4. Extract the active device token matching your schema layout
            const activeDevice = userProfile.PlatformInfo?.devices?.find(
                (device) => device.isLastLoggedIn === true
            );

            const fcmToken = activeDevice?.fcmToken;

            if (!fcmToken) {
                return c.json({
                    success: true,
                    message: "Assignment saved, but no active logged-in device token found for push notification."
                }, 200);
            }

            // 5. Structure a clean FCM notification data packet
            // 5. Structure the complete notification payload matching the surveyor setup
            const structuredBody = "You have a new product pickup and delivery assignment waiting.";

            const message = {
                notification: {
                    title: "📦 New Delivery Assigned!",
                    body: structuredBody,
                },
                android: {
                    priority: "high",
                    notification: {
                        channelId: "custom_sound_channel_v2",
                        sound: "kondaas",
                        clickAction: "FLUTTER_NOTIFICATION_CLICK",
                    },
                    fcmOptions: {
                        analyticsLabel: "logistics_assignment"
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: "kondaas.caf",
                            contentAvailable: true,
                            alert: {
                                title: "📦 New Delivery Assigned!",
                                body: structuredBody,
                                launchImage: ""
                            }
                        }
                    }
                },
                data: {
                    deal_id: String(deal_id),
                    click_action: "FLUTTER_NOTIFICATION_CLICK",
                    type: "LOGISTICS_ASSIGNMENT",
                    // Passing products array serialized or customized if your app parses it directly from data payload
                    products_info: JSON.stringify(products_info || []),
                },
                token: fcmToken, // Targeting the single active device token
            };

            // 6. Send notification 
            const response = await admin.messaging().send(message);

            return c.json({
                success: true,
                message: "Logistics team member successfully assigned and notified!",
                messageId: response
            }, 200);
        });

    } catch (err) {
        console.error("❌ Logistics Assignment Exception Error:", err.message);
        return c.json({ success: false, error: "Internal Server Error during logistics route handling" }, 500);
    }
};


export const getLogRejections = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const rejections = await db.collection("logistics_reject").find({}).sort({ time: -1 }).toArray();
      return c.json({ success: true, count: rejections.length, data: rejections }, 200);
    });
  } catch (err) {
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getLogCompletions = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const completions = await db.collection("logistics_completed").find({}).sort({ time: -1 }).toArray();
      return c.json({ success: true, count: completions.length, data: completions }, 200);
    });
  } catch (err) {
    return c.json({ error: "Internal server error" }, 500);
  }
};


export const assignInstallerMember = async (c) => {
    try {
        // 1. Extract payload from the request body
        const body = await c.req.json();
        const { deal_id, products_info, mobile,address } = body;

        // Validation guard clause
        if (!deal_id || !mobile) {
            return c.json({ success: false, error: "Missing deal_id or mobile number" }, 400);
        }

        return await withDatabase(MONGODB_URI, async (db) => {
            // 2. Upsert the tracking state inside 'Installer_deals'
            await db.collection("Installer_deals").updateOne(
                { deal_id: deal_id },
                {
                    $set: {
                        deal_id,
                        products_info: Array.isArray(products_info) ? products_info : [], // Ensures it saves as a clean array ["2 X Solar Panels", "1 X Inverter"]
                        mobile,
                        address,
                        status: "pending",
                        assignedAt: new Date()
                    }
                },
                { upsert: true }
            );

            // 3. Look up the profile inside 'userdetails' using the mobile variable
            const userProfile = await db.collection("userdetails").findOne({
                "UserInfo.phoneNo": mobile,
                "UserInfo.role": "installer"
            });

            if (!userProfile) {
                return c.json({ success: true, message: "Assignment saved, but logistics member profile not found." }, 200);
            }

            // 4. Extract the active device token matching your schema layout
            const activeDevice = userProfile.PlatformInfo?.devices?.find(
                (device) => device.isLastLoggedIn === true
            );

            const fcmToken = activeDevice?.fcmToken;

            if (!fcmToken) {
                return c.json({
                    success: true,
                    message: "Assignment saved, but no active logged-in device token found for push notification."
                }, 200);
            }

            // 5. Structure a clean FCM notification data packet
            // 5. Structure the complete notification payload matching the surveyor setup
            const structuredBody = "You have a new product pickup and delivery assignment waiting.";

            const message = {
                notification: {
                    title: "📦 New Product Assigned!",
                    body: structuredBody,
                },
                android: {
                    priority: "high",
                    notification: {
                        channelId: "custom_sound_channel_v2",
                        sound: "kondaas",
                        clickAction: "FLUTTER_NOTIFICATION_CLICK",
                    },
                    fcmOptions: {
                        analyticsLabel: "installer_assignment"
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: "kondaas.caf",
                            contentAvailable: true,
                            alert: {
                                title: "📦 New Product Assigned!",
                                body: structuredBody,
                                launchImage: ""
                            }
                        }
                    }
                },
                data: {
                    deal_id: String(deal_id),
                    click_action: "FLUTTER_NOTIFICATION_CLICK",
                    type: "INSTALLER_ASSIGNMENT",
                    // Passing products array serialized or customized if your app parses it directly from data payload
                    products_info: JSON.stringify(products_info || []),
                },
                token: fcmToken, // Targeting the single active device token
            };

            // 6. Send notification 
            const response = await admin.messaging().send(message);

            return c.json({
                success: true,
                message: "Installer team member successfully assigned and notified!",
                messageId: response
            }, 200);
        });

    } catch (err) {
        console.error("❌ Installer Assignment Exception Error:", err.message);
        return c.json({ success: false, error: "Internal Server Error during installer route handling" }, 500);
    }
};


export const getInstallerRejections = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const rejections = await db.collection("installer_reject").find({}).sort({ time: -1 }).toArray();
      return c.json({ success: true, count: rejections.length, data: rejections }, 200);
    });
  } catch (err) {
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const getInstallerCompletions = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const completions = await db.collection("installer_completed").find({}).sort({ time: -1 }).toArray();
      return c.json({ success: true, count: completions.length, data: completions }, 200);
    });
  } catch (err) {
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const whitelistUser = async (c) => {
  try {
    const body = await c.req.json();
    const { mobileNumber, role } = body;

    if (!mobileNumber || !role) {
      return c.json({
        success: false,
        message: "Missing parameters. Both mobileNumber and role are mandatory fields."
      }, 400);
    }

    const cleanMobile = String(mobileNumber).trim();
    const cleanRole = String(role).trim().toLowerCase();

    return await withDatabase(MONGODB_URI, async (db) => {
      const userCollection = db.collection("userDetails");

      // Check for an existing document using the phone number string as the primary key (_id)
      const existingUser = await userCollection.findOne({ _id: cleanMobile });

      if (existingUser) {
        return c.json({
          success: false,
          message: `User profile already exists for ${cleanMobile} under the role: ${existingUser.UserInfo?.role || 'unknown'}`
        }, 409);
      }

      // 🎯 Build the exact nested schema matching your production sample record
      const whitelistedUserProfile = {
        _id: cleanMobile, // Your pattern stores the phone number directly as the unique identifier string
        AppInfo: {
          lastLogin: null
        },
        PlatformInfo: {
          devices: [] // Array shell waiting for saveuserdetails to push into during later logins
        },
        UserInfo: {
          phoneNo: cleanMobile,
          role: cleanRole,
          email: "",
          password: ""
        },
        updatedAt: new Date()
      };

      await userCollection.insertOne(whitelistedUserProfile);

      console.log(`👤 [Admin Success] Whitelisted profile shell created for _id: ${cleanMobile} [Role: ${cleanRole}]`);

      return c.json({
        success: true,
        message: "User pre-authorized in database seamlessly. Ready for device deployment log-in verification."
      }, 201);
    });

  } catch (error) {
    console.error("❌ Exception inside whitelistUser pipeline:", error.message);
    return c.json({
      success: false,
      message: "Internal configuration failure processing profile pre-authorization.",
      error: error.message
    }, 500);
  }
};


//See distance travelled for leads

export const getDealDistance = async (c) => {
  try {
    
    return await withDatabase(MONGODB_URI, async (db) => {
      const collection = db.collection("deal_distance");

      const records = await collection.find({}).toArray();
      return c.json({ success: true, count: records.length, data: records }, 200);
    });

  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};


export const getAllAttendance = async (c) => {
  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      // 1. Fetch all documents from the attendance collection
      const docs = await db.collection("attendance").find({}).toArray();

      // 2. Map documents to clean, standardized response objects
      const result = docs.map((doc) => ({
        id: doc._id ? doc._id.toString() : null,
        phoneNo: doc.phoneNo || null,
        role: doc.role || null,
        history: doc.history || [],
        updatedAt: doc.updatedAt || null
      }));

      return c.json(result);
    });
  } catch (err) {
    console.error("❌ GetAllAttendance Error Exception:", err.message);
    return c.json({ error: "Internal server error", details: err.message }, 500);
  }
};