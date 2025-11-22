import express from 'express';
import http from 'http';
import https from 'https';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { Certify } from '@metric-im/administrate';
// MultiSite will be used later to spawn plugin modules (adnet, secrets, auth, etc.)
import { Epistery, Config } from 'epistery';
import { createAuthRouter } from './authentication.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isShuttingDown = false;
let app, https_server, http_server, config;

let main = async function() {
    app = express();
    app.use(cors({
        origin: function(origin, callback){
            return callback(null, true);
        },
        credentials:true
    }));
    app.use(express.urlencoded({extended: true}));
    app.use(express.json({limit: '50mb'}));
    app.use(cookieParser());

    const epistery = await Epistery.connect();
    await epistery.attach(app);

    // Mount authentication routes
    const authRouter = createAuthRouter();
    app.use(authRouter);

    app.get('/health', (req, res) => {
        res.status(200).send()
    });

    app.get('/agent', (req,res) => {
        res.redirect('/.well-known/epistery/lib/client.js');
    });

    // Main status page
    app.get('/', async (req, res) => {
        try {
            const domain = req.hostname || 'localhost';
            const cfg = new Config(domain);

            // Check if domain is claimed/verified
            if (!cfg.data || !cfg.data.verified) {
                // Domain not claimed - show claim page
                const claimTemplate = readFileSync(path.join(__dirname, 'public', 'claim.html'), 'utf8');
                const html = claimTemplate.replace(/{DOMAIN}/g, domain);
                return res.send(html);
            }

            // Domain is claimed - show regular status page
            const wallet = cfg.wallet || { address: 'Not configured' };
            const template = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
            const html = template
                .replace(/{DOMAIN}/g, domain)
                .replace(/{SERVER_WALLET}/g, wallet.address);

            res.send(html);
        } catch (error) {
            console.error('Error serving index:', error);
            res.status(500).send('Error loading page');
        }
    });

    // Static files (after specific routes)
    app.use('/style', express.static(path.join(__dirname, 'public/style')));
    app.use('/image', express.static(path.join(__dirname, 'public/image')));

    config = new Config();
    const http_port = parseInt(process.env.PORT || 4080);
    const https_port = parseInt(process.env.PORTSSL || 4443);
    const certify = await Certify.attach(app);

    // TODO: MultiSite will be attached here later to spawn plugin modules

    https_server = https.createServer({...certify.SNI},app);
    https_server.listen(https_port);
    https_server.on('error', console.error);
    https_server.on('listening',()=>{
        let address = https_server.address();
        console.log(`Listening on ${address.address} ${address.port} (${address.family})`);
    });
    http_server = http.createServer(app);
    http_server.listen(http_port);
    http_server.on('error', console.error);
    http_server.on('listening',()=>{
        let address = http_server.address();
        console.log(`Listening on ${address.address} ${address.port} (${address.family})`);
    });
}();

const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`Received ${signal}, shutting down gracefully...`);

    try {
        // Stop accepting new connections
        if (https_server) {
            await new Promise(resolve => https_server.close(resolve));
            console.log('HTTPS server closed');
        }

        if (http_server) {
            await new Promise(resolve => http_server.close(resolve));
            console.log('HTTP server closed');
        }

        // TODO: Cleanup spawned plugin modules when MultiSite is implemented

        console.log('Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
