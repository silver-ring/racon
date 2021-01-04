import * as express from 'express';

import {ValidateController} from './controllers/validate';
import {TokenController} from './controllers/token';
import {ValidateConsume} from "./messages/validate";

const faye = require('faye');
const http = require('http');

const app: express.Application = express();
const port: number = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use('/token', TokenController);
app.use('/validate', ValidateController);

app.listen(port, () => {
    console.log(`Listening at http://localhost:${port}/`);
});

const server = http.createServer();
const bayeux = new faye.NodeAdapter({mount: '/'});

bayeux.attach(server);
server.listen(8000);

const client = new faye.Client('http://localhost:8000/');

client.subscribe('/validate', async (message: any) => {
    const validateConsume = new ValidateConsume();
    await validateConsume.validateC4(message);
});
