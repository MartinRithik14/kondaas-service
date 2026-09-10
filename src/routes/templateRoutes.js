import { Hono } from 'hono';
import { createTemplate, updateTemplate, getTemplate } from '../controllers/templateController.js';

const templateRoutes = new Hono();


templateRoutes.post('/create', createTemplate);


templateRoutes.put('/update', updateTemplate);


templateRoutes.get('/get/:id', getTemplate);



export default templateRoutes;