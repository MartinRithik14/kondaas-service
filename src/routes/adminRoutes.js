import { Hono } from 'hono';

import { getDealInfo,getAllAttendance,assignLogisticsMember,getLogRejections,getDealDistance,getLogCompletions,assignInstallerMember,getInstallerRejections,getInstallerCompletions,whitelistUser } from '../controllers/adminController.js';

const adminRoutes = new Hono();

adminRoutes.get('/products', getDealInfo);
adminRoutes.get("/attendance", getAllAttendance);
adminRoutes.post('/assign-role', whitelistUser);
adminRoutes.get('/distance', getDealDistance);


adminRoutes.post('/assign-logistic', assignLogisticsMember);
adminRoutes.get('/logistics-rejections', getLogRejections);
adminRoutes.get('/logistics-completions', getLogCompletions);

adminRoutes.post('/assign-installer', assignInstallerMember);
adminRoutes.get('/installer-rejections', getInstallerRejections);
adminRoutes.get('/installer-completions', getInstallerCompletions);

export default adminRoutes;
