// src/chat/contacts.controller.ts
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Controller('contacts')
@UseGuards(AuthGuard('jwt'))
export class ContactsController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get(':contactId')
  async getContactInfo(@Param('contactId') contactId: string) {
    const formattedId = contactId.includes('@') ? contactId : `${contactId}@c.us`;
    return this.whatsappService.getContactInfo(formattedId);
  }
}