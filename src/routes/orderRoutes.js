import { Hono } from 'hono';
import { addOrder,zohoDealCreatedWebhook,rejectOrder,deleteDeal,getOrders,getAdminRejections,getAdminCompletions,deleteOrder,completeOrder,updateSurveyStatus,handleZohoDealWebhook,assignDealToSurveyor,zohoWorkflowAssignment,getSurveyorDeals } from '../controllers/orderController.js';

const orderRoutes = new Hono();

orderRoutes.post('/add', addOrder);
orderRoutes.post('/zoho-deal-created', zohoDealCreatedWebhook);
orderRoutes.post('/reject', rejectOrder);
orderRoutes.delete('/delete', deleteDeal);
orderRoutes.post('/complete', completeOrder);
orderRoutes.get('/all', getOrders);
orderRoutes.get('/admin-rejections', getAdminRejections);
orderRoutes.get('/admin-completions', getAdminCompletions);
orderRoutes.delete('/delete', deleteOrder);
orderRoutes.put('/updatestatus', updateSurveyStatus);
orderRoutes.post('/webhook', handleZohoDealWebhook);
orderRoutes.post('/assign', assignDealToSurveyor);
orderRoutes.post('/zoho-assign', zohoWorkflowAssignment);
orderRoutes.get('/surveyor', getSurveyorDeals);



export default orderRoutes;