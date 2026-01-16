import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { ChatModule } from '../chat/chat.module';
import { EventEmitterModule } from '@nestjs/event-emitter'; // <-- 1. AÑADE ESTA LÍNEA

@Module({
  imports: [
    forwardRef(() => ChatModule),
    EventEmitterModule, // <-- 2. AÑADE ESTA LÍNEA AQUÍ TAMBIÉN
  ],
  providers: [WhatsappService],
  exports: [WhatsappService]
})
export class WhatsappModule {}