import { Hono } from 'hono';

import { addLocation,getInstallerInstallations,installationWebhook,getLocationByTime, getCurrentLocation } from '../controllers/installerController.js';

const installerRoutes = new Hono();

installerRoutes.post('/add', addLocation);
installerRoutes.post('/bytime', getLocationByTime);
installerRoutes.post('/current', getCurrentLocation);


installerRoutes.post('/assign', installationWebhook);

installerRoutes.get('/installations', getInstallerInstallations);
export default installerRoutes;