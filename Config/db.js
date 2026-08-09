import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  // eslint-disable-next-line no-undef
  connectionString: process.env.DATABASE_URL,
});

export default pool;
