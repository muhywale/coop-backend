import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

// REGISTER - member self-registers using email + phone to match their existing member record
export const register = async (req, res) => {
  try {
    const { phone, member_email, login_email, password } = req.body;

    // find the matching member record using phone + the email on file
    const member = await pool.query(
      'SELECT * FROM members WHERE phone = $1 AND email = $2',
      [phone, member_email]
    );

    if (member.rows.length === 0) {
      return res.status(404).json({
        error:
          'No matching member record found. Check your phone number and email, or contact the cooperative.',
      });
    }

    const memberRecord = member.rows[0];

    // check this member doesn't already have a login
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE member_id = $1',
      [memberRecord.id]
    );
    if (existingUser.rows.length > 0) {
      return res
        .status(409)
        .json({
          error:
            'An account already exists for this member. Please login instead.',
        });
    }

    // check the login email isn't already taken by someone else
    const emailTaken = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [login_email]
    );
    if (emailTaken.rows.length > 0) {
      return res
        .status(409)
        .json({ error: 'This email is already registered.' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (member_id, email, password_hash) 
       VALUES ($1, $2, $3) RETURNING id, member_id, email, role`,
      [memberRecord.id, login_email, password_hash]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// LOGIN - unchanged
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [
      email,
    ]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, memberId: user.member_id, role: user.role },
      // eslint-disable-next-line no-undef
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        member_id: user.member_id,
      },
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
};
