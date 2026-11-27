import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Invite, InviteSchema } from './schemas/invite.schema.js';
import { InvitesService } from './invites.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Invite.name, schema: InviteSchema }]),
  ],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
