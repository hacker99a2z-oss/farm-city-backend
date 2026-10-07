require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
  }
});

// Initialize database tables
async function initDatabase() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(255),
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        photo_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Balances table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS balances (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        withdraw_balance DECIMAL(10, 2) DEFAULT 0.00,
        game_balance DECIMAL(10, 2) DEFAULT 0.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      )
    `);

    // Referrals table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        referred_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        referral_code VARCHAR(20) UNIQUE NOT NULL,
        earnings DECIMAL(10, 2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(referred_id)
      )
    `);

    // Transactions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Withdrawal requests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(10, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        payment_details TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

initDatabase();

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Farm City API is running' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Telegram WebApp auth endpoint
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;

    // Validate Telegram initData (simplified version)
    // In production, you should verify the hash using bot token
    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get('user');

    if (!userStr) {
      return res.status(400).json({ error: 'Invalid init data' });
    }

    const user = JSON.parse(userStr);
    const telegramId = user.id;

    // Check if user exists
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    let userId;

    if (userResult.rows.length === 0) {
      // Create new user
      const newUser = await pool.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [telegramId, user.username, user.first_name, user.last_name, user.photo_url]
      );
      userId = newUser.rows[0].id;

      // Create balance for new user
      await pool.query(
        'INSERT INTO balances (user_id) VALUES ($1)',
        [userId]
      );

      // Generate referral code
      const referralCode = 'FC' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await pool.query(
        'INSERT INTO referrals (referrer_id, referral_code) VALUES ($1, $2)',
        [userId, referralCode]
      );
    } else {
      userId = userResult.rows[0].id;
    }

    // Get user balance
    const balanceResult = await pool.query(
      'SELECT * FROM balances WHERE user_id = $1',
      [userId]
    );

    res.json({
      success: true,
      user: {
        id: userId,
        telegram_id: telegramId,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        photo_url: user.photo_url
      },
      balance: balanceResult.rows[0]
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Get user balance
app.get('/api/balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM balances WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Withdraw request
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, paymentMethod, paymentDetails } = req.body;

    // Check user balance
    const balanceResult = await pool.query(
      'SELECT withdraw_balance FROM balances WHERE user_id = $1',
      [userId]
    );

    if (balanceResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentBalance = parseFloat(balanceResult.rows[0].withdraw_balance);
    const withdrawAmount = parseFloat(amount);

    if (withdrawAmount > currentBalance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create withdrawal request
    await pool.query(
      `INSERT INTO withdrawals (user_id, amount, payment_method, payment_details)
       VALUES ($1, $2, $3, $4)`,
      [userId, withdrawAmount, paymentMethod, paymentDetails]
    );

    // Deduct from balance
    await pool.query(
      'UPDATE balances SET withdraw_balance = withdraw_balance - $1 WHERE user_id = $2',
      [withdrawAmount, userId]
    );

    res.json({ success: true, message: 'Withdrawal request submitted' });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// Get referral info
app.get('/api/referral/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT referral_code,
              (SELECT COUNT(*) FROM referrals WHERE referrer_id = $1) as total_referrals,
              COALESCE(SUM(earnings), 0) as total_earnings
       FROM referrals WHERE referrer_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Referral not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Referral error:', error);
    res.status(500).json({ error: 'Failed to fetch referral info' });
  }
});

// Sell product
app.post('/api/sell', async (req, res) => {
  try {
    const { userId, productId, amount } = req.body;

    // Add to game balance
    await pool.query(
      'UPDATE balances SET game_balance = game_balance + $1 WHERE user_id = $2',
      [amount, userId]
    );

    // Record transaction
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description)
       VALUES ($1, $2, $3, $4)`,
      [userId, 'sell', amount, `Sold product ${productId}`]
    );

    res.json({ success: true, message: 'Product sold successfully' });
  } catch (error) {
    console.error('Sell error:', error);
    res.status(500).json({ error: 'Sell failed' });
  }
});

// Get withdrawal history
app.get('/api/withdrawals/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Withdrawals error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
