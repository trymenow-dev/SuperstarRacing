const express = require('express');
const path = require('path');
const app = express();

const PORT = 7100;

app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Server is running!');
});

app.listen(PORT, () => {
  console.log(`server_all_v2 listening on ${PORT}`);
});
