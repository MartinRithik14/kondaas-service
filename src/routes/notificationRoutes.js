import { Hono } from 'hono';
import { addNotification,handleInteraktWebhook,triggerScenarioNotification,updateNotification,handleSurveyorPhotoUpload } from '../controllers/notificationController.js';

const notificationRoutes = new Hono();

notificationRoutes.post('/add', addNotification);
notificationRoutes.post('/trigger', triggerScenarioNotification);
notificationRoutes.post('/interakt-webhook', handleInteraktWebhook);
notificationRoutes.put('/update', updateNotification);
notificationRoutes.post('/daily-photo', handleSurveyorPhotoUpload);



export default notificationRoutes;