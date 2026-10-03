import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MaterialDocumentDefinition, MaterialSchema } from './persistence/material.schema';
import { JobDocumentDefinition, JobSchema } from './persistence/job.schema';
import { ChannelDocumentDefinition, ChannelSchema } from './persistence/channel.schema';
import { MaterialService } from './material/material.service';
import { JobService } from './job/job.service';
import { ChannelService } from './channel/channel.service';
import { ChannelController, JobController, MaterialController } from './http/controllers';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
      { name: JobDocumentDefinition.name, schema: JobSchema },
      { name: ChannelDocumentDefinition.name, schema: ChannelSchema },
    ]),
  ],
  controllers: [MaterialController, JobController, ChannelController],
  providers: [MaterialService, JobService, ChannelService],
  exports: [MaterialService, JobService, ChannelService],
})
export class ViscoModule {}
