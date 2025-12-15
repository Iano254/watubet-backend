import express from 'express';
import http from 'http';
import cors from 'cors';
import { setupSocketServer } from '../socketServer';
import gameRoutes from '../gameRoutes';
import axios from 'axios';


const instance = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:3001', // adjust the port if necessary
});

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

app.use('/api/game', gameRoutes);

setupSocketServer(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app