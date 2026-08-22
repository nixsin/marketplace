import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InquiriesResolver } from './inquiries.resolver';
import { InquiriesService } from './inquiries.service';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [PrismaModule],
  providers: [InquiriesResolver, InquiriesService, WhatsappService],
})
export class InquiriesModule {}
