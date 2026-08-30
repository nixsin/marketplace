import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import type { Request } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ProductsModule } from './products/products.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    StorageModule,
    ConfigModule.forRoot({ isGlobal: true }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      // Renamed in @nestjs/graphql 14: `playground` (Apollo's hosted
      // Playground, long deprecated) is gone and GraphiQL is the built-in
      // IDE. Same intent -- an explorer in dev, nothing exposed in prod.
      graphiql: process.env.NODE_ENV !== 'production',
      context: ({ req }: { req: Request }) => ({ req }),
    }),
    PrismaModule,
    AuthModule,
    OrganizationsModule,
    ProductsModule,
    InquiriesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
