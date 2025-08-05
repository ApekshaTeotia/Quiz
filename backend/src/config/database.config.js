import { configService } from '../services/configService.js';

const dbConfig = configService.get('database');

export const databaseConfig = {
    host: dbConfig.host,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.name,
    waitForConnections: true,
    connectionLimit: dbConfig.connectionLimit,
    queueLimit: dbConfig.queueLimit,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    timezone: '+00:00',
    multipleStatements: true,
    charset: 'utf8mb4',
    namedPlaceholders: true,
    connectTimeout: 60000, // 60 seconds
    acquireTimeout: 60000,
    timeout: 60000,
    socketPath: process.platform === 'win32' ? null : '/var/run/mysqld/mysqld.sock',
    ssl: process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: false
    } : undefined,
    debug: process.env.NODE_ENV === 'development',
    trace: process.env.NODE_ENV === 'development',
    // Additional connection retry settings
    retry: {
        max: 3,
        delay: 5000
    }
};
