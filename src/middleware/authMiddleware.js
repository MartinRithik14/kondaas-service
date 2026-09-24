import { withDatabase } from '../utils/config.js';

const MONGODB_URI = process.env.MONGODB_URI;



export const requireAuth = async (c, next) => {
  try {
    // 1. Read authentication headers
    const incomingToken = c.req.header('x-auth-token');
    const mobile = c.req.header('x-user-phone') || c.req.header('x-phone-no');

    // 2. Reject if either header is missing
    if (!incomingToken) {
      return c.json({ error: "Unauthorized: Missing authentication token ('x-auth-token')" }, 401);
    }
    if (!mobile) {
      return c.json({ error: "Unauthorized: Missing user phone ('x-user-phone')" }, 401);
    }

    // 3. Check MongoDB for matching user and active device session
    return await withDatabase(MONGODB_URI, async (db) => {
      const user = await db.collection("userDetails").findOne({
        _id: mobile,
        "PlatformInfo.devices.authToken": incomingToken
      });

      if (!user) {
        return c.json({ 
          error: "Unauthorized: Invalid or expired session. Please re-login." 
        }, 401);
      }

      // 4. Attach verified user profile to request context for downstream handlers
      c.set('user', user);

      // 5. Proceed to the actual route handler
      await next();
    });
  } catch (err) {
    return c.json({ error: "Internal Auth Error", details: err.message }, 500);
  }
};