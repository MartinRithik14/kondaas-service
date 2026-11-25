import { Hono } from 'hono';

import { addLocation,triggerInstallationNotification,rejectInstallation,addInstallationNote,installationCheckIn,updateInstallationDetails,updateInstallationStatus,getInstallerInstallations,installationWebhook,getLocationByTime, getCurrentLocation } from '../controllers/installerController.js';

const installerRoutes = new Hono();

installerRoutes.post('/add', addLocation);
installerRoutes.post('/notes', addInstallationNote);
installerRoutes.post('/notification', triggerInstallationNotification);
installerRoutes.post('/reject', rejectInstallation);
installerRoutes.post('/check-in', installationCheckIn);

installerRoutes.put('/form', updateInstallationDetails);

installerRoutes.post('/bytime', getLocationByTime);
installerRoutes.post('/current', getCurrentLocation);
installerRoutes.put('/status', updateInstallationStatus);

installerRoutes.post('/assign', installationWebhook);

installerRoutes.get('/installations', getInstallerInstallations);
export default installerRoutes;