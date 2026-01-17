import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ChatModule } from '../chat/chat.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    forwardRef(() => ChatModule),
    EventEmitterModule,
  ],
  providers: [WhatsappService],
  exports: [WhatsappService]
})
export class WhatsappModule {}