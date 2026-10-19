// Migrations, oldest first. Don't edit a released migration; add a new one.

import type { Migration } from '../migrate';
import { baseline } from './001-baseline';
import { integrity } from './002-integrity';
import { modelResults } from './003-model-results';
import { pipelineRuns } from './004-pipeline-runs';
import { rubricsAndTopicAssignments } from './005-rubrics-and-topic-assignments';
import { gradeConsistency } from './006-grade-consistency';

export const MIGRATIONS: Migration[] = [baseline, integrity, modelResults, pipelineRuns, rubricsAndTopicAssignments, gradeConsistency];
