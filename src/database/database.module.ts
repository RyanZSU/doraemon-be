import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, type MongooseModuleOptions } from '@nestjs/mongoose';

/**
 * Single MongoDB connection for the whole app.
 *
 * `retryWrites: false` is required by Azure DocumentDB (MongoDB vCore)
 * connection strings. Indexes are built on startup during early development;
 * once collections grow, move index creation to a migration script and disable
 * `autoIndex`.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): MongooseModuleOptions => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        dbName: config.getOrThrow<string>('MONGO_DB_NAME'),
        retryWrites: false,
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 20,
      }),
    }),
  ],
})
export class DatabaseModule {}