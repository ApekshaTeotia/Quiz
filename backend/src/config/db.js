// backend/src/config/db.js
import mysql from 'mysql2/promise';
import configService from '../services/configService.js';
import { logger } from '../utils/logger.js';

/**
 * Enhanced database configuration with connection monitoring
 */
class Database {
  constructor() {
    this.pool = null;
    this.isConnected = false;
    this.connectionErrors = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
    this.healthCheck = null;

    // Initialize connection
    this.initialize();
  }

  /**
   * Initialize the database connection pool
   */
  async initialize() {
    try {
      const dbConfig = configService.get('database');

      logger.info('Initializing database connection with config:', {
        host: dbConfig.host,
        user: dbConfig.user,
        database: dbConfig.name,
        connectionLimit: dbConfig.connectionLimit
      });

      // Create connection pool
      this.pool = mysql.createPool({
        host: dbConfig.host,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.name,
        waitForConnections: true,
        connectionLimit: dbConfig.connectionLimit,
        queueLimit: dbConfig.queueLimit,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000, // 10 seconds
        timezone: '+00:00', // UTC
        multipleStatements: true, // Allow multiple SQL statements
        charset: 'utf8mb4', // Support full UTF-8
        namedPlaceholders: true // Enable named placeholders
      });

      logger.info('Database connection pool initialized');

      // Setup connection monitoring
      this.setupConnectionMonitoring();

      // Test connection and initialize schema
      await this.testConnection();
      await this.initializeSchema();
    } catch (error) {
      logger.error('Failed to initialize database connection pool:', error);
      this.isConnected = false;

      // Schedule reconnection attempt
      this.scheduleReconnect();
    }
  }

  /**
   * Setup connection monitoring
   */
  setupConnectionMonitoring() {
    // Clear any existing health check interval
    if (this.healthCheck) {
      clearInterval(this.healthCheck);
    }

    // Set up new health check interval
    this.healthCheck = setInterval(async () => {
      try {
        await this.testConnection(false);
      } catch (error) {
        logger.error('Database health check failed:', error);

        // If connection is lost, attempt to reconnect
        if (this.isConnected) {
          this.isConnected = false;
          this.scheduleReconnect();
        }
      }
    }, 30000); // Check every 30 seconds

    // Clean up on process exit
    process.on('exit', () => {
      this.cleanup();
    });

    // Handle process termination signals
    process.on('SIGINT', () => {
      this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Test database connection
   * @param {boolean} logSuccess - Whether to log successful connection
   * @returns {Promise<boolean>} Connection success
   */
  async testConnection(logSuccess = true) {
    try {
      if (!this.pool) {
        throw new Error('Database pool not initialized');
      }

      const connection = await this.pool.getConnection();

      try {
        // Check if database exists
        const [dbCheck] = await connection.execute(
          `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`,
          [configService.get('database').name]
        );

        if (dbCheck.length === 0) {
          // Database doesn't exist, create it
          const dbName = configService.get('database').name;
          await connection.execute(`CREATE DATABASE IF NOT EXISTS ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
          logger.info(`Created database: ${dbName}`);
          
          // Use the new database
          await connection.execute(`USE ${dbName}`);
        }

        // Execute a simple query to verify connection
        const [result] = await connection.execute('SELECT 1 AS connection_test');
        
        if (result[0].connection_test === 1) {
          // Update connection status
          if (!this.isConnected) {
            this.isConnected = true;
            this.connectionErrors = 0;
            this.reconnectAttempts = 0;

            if (logSuccess) {
              logger.info('Database connection established successfully');
            }
          }
          return true;
        }
      } finally {
        // Always release the connection back to the pool
        connection.release();
      }
    } catch (error) {
      this.isConnected = false;
      this.connectionErrors++;

      logger.error(`Database connection test failed (Error #${this.connectionErrors}):`, error);
      logger.error('Error details:', {
        code: error.code,
        errno: error.errno,
        sqlState: error.sqlState,
        sqlMessage: error.sqlMessage
      });

      // Handle specific MySQL errors
      switch (error.code) {
        case 'ER_ACCESS_DENIED_ERROR':
          logger.error('Access denied. Please check database username and password.');
          break;
        case 'ECONNREFUSED':
          logger.error('Connection refused. Please check if MySQL server is running.');
          break;
        case 'ER_BAD_DB_ERROR':
          logger.error('Database does not exist.');
          break;
        default:
          logger.error('Unknown database error:', error.message);
      }

      throw error;
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Maximum reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    this.reconnectAttempts++;

    // Calculate exponential backoff delay with jitter
    const delay = Math.min(
      30000, // max 30 seconds
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1) * (1 + Math.random() * 0.2)
    );

    logger.info(`Scheduling database reconnection attempt #${this.reconnectAttempts} in ${Math.round(delay / 1000)} seconds`);

    setTimeout(() => {
      this.initialize();
    }, delay);
  }

  /**
   * Clean up resources on shutdown
   */
  cleanup() {
    logger.info('Closing database connection pool');

    // Clear health check interval
    if (this.healthCheck) {
      clearInterval(this.healthCheck);
      this.healthCheck = null;
    }

    // Close connection pool if it exists
    if (this.pool) {
      this.pool.end().catch(err => {
        logger.error('Error closing database connection pool:', err);
      });
    }
  }

  /**
   * Get the connection pool
   * @returns {Object} MySQL connection pool
   */
  getPool() {
    return this.pool;
  }

  /**
   * Execute a query using a connection from the pool
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>} Query results
   */
  async query(sql, params = []) {
    try {
      const [results] = await this.pool.execute(sql, params);
      return results;
    } catch (error) {
      logger.error('Database query error:', error);
      logger.error('Query:', sql);
      logger.error('Parameters:', params);
      throw error;
    }
  }

  /**
   * Get a new connection from the pool
   * @returns {Promise<Object>} Database connection
   */
  async getConnection() {
    try {
      return await this.pool.getConnection();
    } catch (error) {
      logger.error('Error getting database connection:', error);
      throw error;
    }
  }

  /**
   * Initialize database schema
   */
  async initializeSchema() {
    const connection = await this.getConnection();
    try {
      logger.info('Initializing database schema...');
      
      // Read and execute schema SQL
      const schemaPath = new URL('../database.sql', import.meta.url);
      const schema = await fs.promises.readFile(schemaPath, 'utf8');
      
      // Split SQL into individual statements
      const statements = schema
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      // Execute each statement
      for (const sql of statements) {
        await connection.execute(sql + ';');
      }
      
      logger.info('Database schema initialized successfully');
    } catch (error) {
      logger.error('Error initializing database schema:', error);
      throw error;
    } finally {
      connection.release();
    }
  }
}

// Create singleton instance
const database = new Database();

// Export the database instance and convenience methods
export const pool = database.getPool();
export const testConnection = () => database.testConnection();
export const dbQuery = (sql, params) => database.query(sql, params);
export const getConnection = () => database.getConnection();

export default database;