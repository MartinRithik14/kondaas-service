import admin from 'firebase-admin';

export const verifyFirebaseToken = async (idToken) => {
  return await admin.auth().verifyIdToken(idToken);
};

export default admin;