    import { Hono } from 'hono';

    import { addLocation, getLocationByTime,getMyDispatches,updateDispatchOrPackageStatus,getCurrentLocation,createLogisticsProduct,logLogisticsCompletion,updateProductStatus,updateLogisticsStatus,getLogisticsDealsByMobile,rejectLogisticsDeal,handleDispatchWebhook,uploadPackageDeliveryPhotos } from '../controllers/logisticController.js';

    const logisticRoutes = new Hono();

    logisticRoutes.post('/add', addLocation);
    logisticRoutes.post('/bytime', getLocationByTime);
    logisticRoutes.post('/current', getCurrentLocation);

    logisticRoutes.get('/deals', getLogisticsDealsByMobile);

    logisticRoutes.post('/products', createLogisticsProduct);

    logisticRoutes.put('/update-products', updateProductStatus);
    logisticRoutes.put('/update-status', updateLogisticsStatus);

    logisticRoutes.post('/reject', rejectLogisticsDeal);
    logisticRoutes.post('/complete', logLogisticsCompletion);


    logisticRoutes.post('/dispatch-webhook', handleDispatchWebhook);
    logisticRoutes.get('/my-dispatches', getMyDispatches);

    logisticRoutes.put('/update-shipment', updateDispatchOrPackageStatus);
    logisticRoutes.post('/upload-package-photos', uploadPackageDeliveryPhotos);

    export default logisticRoutes;