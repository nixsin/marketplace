import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InquiriesResolver } from './inquiries.resolver';
import { InquiriesService } from './inquiries.service';

@Module({
  imports: [PrismaModule],
  providers: [InquiriesResolver, InquiriesService],
})
export class InquiriesModule {}
