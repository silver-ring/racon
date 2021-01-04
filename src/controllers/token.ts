import {Request, Response, Router} from 'express';
import * as fs from "fs-extra";
import {google} from "googleapis";

const router: Router = Router();

router.get('/', (req: Request, res: Response) => {

    const credentials = fs.readJSONSync('credentials.json');

    const {client_secret, client_id, redirect_uris} = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/spreadsheets'],
        state: 'consent'
    });

    res.send(authUrl);
});

export const TokenController: Router = router;
