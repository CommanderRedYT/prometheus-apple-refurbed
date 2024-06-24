#!/usr/bin/env node
import { JSDOM } from 'jsdom';
import * as promClient from 'prom-client';
import dotenv from 'dotenv';
import express from 'express';
import UserAgent from "user-agents";

const registry = new promClient.Registry();

dotenv.config();

const {
    CONFIG_COUNTRY = 'at',
    CONFIG_DEVICE = 'mac',
    LISTEN_ADDRESS = '0.0.0.0',
    LISTEN_PORT = '9567',
    DEBUG = 'false',
} = process.env;

const ENABLE_DEBUG = DEBUG === 'true';

if (!ENABLE_DEBUG) {
    console.log = () => {}
}

const getURL = (country, device) => `https://www.apple.com/${country}/shop/refurbished/${device}`;

const extractData = async (url) => {
    console.log('Fetching data from:', url);

    try {
        const data = await fetch(url, {
            // set user agent
            headers: {
                ['User-Agent']: new UserAgent().toString(),
            }
        });

        const html = await data.text();

        const dom = new JSDOM(html, {runScripts: 'dangerously'});

        return dom.window.REFURB_GRID_BOOTSTRAP;
    } catch (error) {
        console.error('Error fetching data:', error);

        return null;
    }
};

promClient.collectDefaultMetrics({
    register: registry,
});

promClient.register.setDefaultLabels({
    app: 'apple-refurbished',
});

// use gauge and set value to 1. put all the data into the labels. for every device in the list, add a new gauge
let gauge = null;

const fetchData = async (country = CONFIG_COUNTRY, device = CONFIG_DEVICE) => {
    const url = getURL(country, device);

    const data = await extractData(url);

    if (!data) {
        console.log('No data received');
        return false;
    }

    if (!data.tiles?.length) {
        console.log('tiles?.length === false')
        return false;
    }

    const { tiles } = data;

    let labels = new Set();

    console.log('Getting labels from tiles:', tiles.length);

    tiles.forEach(({ filters }) => {
        const { dimensions } = filters;
        const keys = Object.keys(dimensions);
        keys.forEach(key => {
            labels.add(key);
        })
    });

    console.log('Labels:', labels);

    if (!gauge) {
        gauge = new promClient.Gauge({
            name: 'apple_refurbished',
            help: 'Apple Refurbished',
            labelNames: [...Array.from(labels), 'partNumber', 'country', 'device'],
            registers: [registry],
        });
    }

    gauge.reset();

    tiles.forEach(({ filters, partNumber, price }) => {
        const { dimensions } = filters;
        const data = {
            ...dimensions,
            partNumber,
            device,
            country,
        };

        const { currentPrice } = price;
        const { raw_amount } = currentPrice;

        gauge.set(data, Number.parseFloat(raw_amount));
    });

    return true;
}

const app = express();

app.get('/metrics', async (req, res) => {
    try {
        const {device, country} = req.query;

        if (!await fetchData(country, device)) {
            res.status(500).send('Error fetching data');
            return;
        }

        res.set('Content-Type', registry.contentType);
        res.end(await registry.metrics());
    } catch (e) {
        console.log('Error', e);
        res.status(500).send('Error fetching data');
        return;
    }
});

app.get('/raw', async (req, res) => {
    const {device, country} = req.query;

    const url = getURL(country ?? CONFIG_COUNTRY, device ?? CONFIG_DEVICE);

    const data = await extractData(url);

    if (!data) {
        res.status(500).send('Error fetching data');
        return;
    }

    res.json(data);
});

app.listen(LISTEN_PORT, LISTEN_ADDRESS, () => {
    console.info(`Listening on http://${LISTEN_ADDRESS}:${LISTEN_PORT}`);
});
