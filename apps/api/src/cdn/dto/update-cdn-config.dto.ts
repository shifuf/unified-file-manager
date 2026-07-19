import { PartialType } from '@nestjs/swagger';

import { CreateCdnConfigDto } from './create-cdn-config.dto';

export class UpdateCdnConfigDto extends PartialType(CreateCdnConfigDto) {}
