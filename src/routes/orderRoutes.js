import { Hono } from 'hono';
import { addOrder,addDealNote,zohoDealCreatedWebhook,rejectOrder,getOrders,getAdminRejections,getAdminCompletions,deleteOrder,completeOrder,updateSurveyStatus,handleZohoDealWebhook,assignDealToSurveyor,zohoWorkflowAssignment,getSurveyorDeals } from '../controllers/orderController.js';

const orderRoutes = new Hono();

orderRoutes.post('/add', addOrder);
orderRoutes.post('/note', addDealNote);
orderRoutes.post('/reject', rejectOrder);
orderRoutes.post('/complete', completeOrder);
orderRoutes.get('/all', getOrders);
orderRoutes.get('/admin-rejections', getAdminRejections);
orderRoutes.get('/admin-completions', getAdminCompletions);
orderRoutes.delete('/delete', deleteOrder);
orderRoutes.put('/updatestatus', updateSurveyStatus);
orderRoutes.post('/assign', assignDealToSurveyor);

orderRoutes.post('/zoho-assign', zohoWorkflowAssignment);
orderRoutes.post('/zoho-deal-created', zohoDealCreatedWebhook);
orderRoutes.post('/webhook', handleZohoDealWebhook);

orderRoutes.get('/surveyor', getSurveyorDeals);



export default orderRoutes;