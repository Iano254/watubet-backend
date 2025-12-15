import express from 'express';
import http from 'http';
import cors from 'cors';
import { setupSocketServer, getOnlineUsersStats } from './socketServer.ts';
import gameRoutes from './gameRoutes.ts';

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

app.use('/api/game', gameRoutes);

app.get('/api/game', (req, res) => {
  res.json({ message: 'This is a sample API route lola.' });
  console.log("This is a sample API route lola.");
});

// In your game server's main file (e.g., app.js or server.js)
app.get('/api/online-users', (req, res) => {
  const onlineStats = getOnlineUsersStats(); // This function should be available in your game server
  res.json(onlineStats);
});

setupSocketServer(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});