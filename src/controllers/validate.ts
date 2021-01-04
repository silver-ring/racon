import {Request, Response, Router} from 'express';
import {sheets_v4} from "googleapis";

const router: Router = Router();
const faye = require('faye');
const client = new faye.Client('http://localhost:8000/');

router.get('/', async (req: Request, res: Response) => {
    client.publish('/validate', req.body);
    res.send('Validation Process Started Result will be recived by email').status(200);
});

export const ValidateController: Router = router;
