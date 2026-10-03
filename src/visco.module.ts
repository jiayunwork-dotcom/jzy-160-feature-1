import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MaterialDocumentDefinition, MaterialSchema } from './persistence/material.schema';
import { JobDocumentDefinition, JobSchema } from './persistence/job.schema';
import {
  TrackBatchDefinition,
  TrackBatchSchema,
  TrackChannelDefinition,
  TrackChannelSchema,
} from './persistence/track.schema';
import { MaterialService } from './material/material.service';
import { JobService } from './job/job.service';
import { TrackService } from './track/track.service';
import { JobController, MaterialController, TrackController } from './http/controllers';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
      { name: JobDocumentDefinition.name, schema: JobSchema },
      { name: TrackChannelDefinition.name, schema: TrackChannelSchema },
      { name: TrackBatchDefinition.name, schema: TrackBatchSchema },
    ]),
  ],
  controllers: [MaterialController, JobController, TrackController],
  providers: [MaterialService, JobService, TrackService],
  exports: [MaterialService, JobService, TrackService],
})
export class ViscoModule {}
