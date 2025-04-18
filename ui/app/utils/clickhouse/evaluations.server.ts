import { getConfig } from "../config/index.server";
import { resolveInput } from "../resolve.server";
import { clickhouseClient } from "./client.server";
import { inputSchema } from "./common";
import {
  EvaluationRunInfoSchema,
  EvaluationStatisticsSchema,
  type EvaluationResult,
  type EvaluationRunInfo,
  type EvaluationStatistics,
  type EvaluationInfoResult,
  evaluationInfoResultSchema,
  getEvaluatorMetricName,
  type EvaluationResultWithVariant,
  type ParsedEvaluationResultWithVariant,
  type ParsedEvaluationResult,
  JsonEvaluationResultSchema,
  ChatEvaluationResultSchema,
  ParsedEvaluationResultWithVariantSchema,
} from "./evaluations";
import { uuidv7ToTimestamp } from "./helpers";

export async function getEvaluationRunInfos(
  evaluation_run_ids: string[],
  function_name: string,
): Promise<EvaluationRunInfo[]> {
  const query = `
    SELECT DISTINCT run_tag.value as evaluation_run_id, run_tag.variant_name as variant_name
    FROM TagInference AS run_tag
    WHERE run_tag.key = 'tensorzero::evaluation_run_id'
      AND run_tag.value IN ({evaluation_run_ids:Array(String)})
      AND run_tag.function_name = {function_name:String}
    ORDER BY toUInt128(toUUID(evaluation_run_id)) DESC
  `;

  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      evaluation_run_ids: evaluation_run_ids,
      function_name: function_name,
    },
  });

  const rows = await result.json<EvaluationRunInfo[]>();
  return rows.map((row) => EvaluationRunInfoSchema.parse(row));
}

async function parseEvaluationResult(
  result: EvaluationResult,
): Promise<ParsedEvaluationResult> {
  // Parse the input field
  const parsedInput = inputSchema.parse(JSON.parse(result.input));
  const resolvedInput = await resolveInput(parsedInput);

  // Parse the outputs
  const generatedOutput = JSON.parse(result.generated_output);
  const referenceOutput = JSON.parse(result.reference_output);

  // Determine if this is a chat result by checking if generated_output is an array
  if (Array.isArray(generatedOutput)) {
    // This is likely a chat evaluation result
    return ChatEvaluationResultSchema.parse({
      ...result,
      input: resolvedInput,
      generated_output: generatedOutput,
      reference_output: referenceOutput,
    });
  } else {
    // This is likely a JSON evaluation result
    return JsonEvaluationResultSchema.parse({
      ...result,
      input: resolvedInput,
      generated_output: generatedOutput,
      reference_output: referenceOutput,
    });
  }
}

async function parseEvaluationResultWithVariant(
  result: EvaluationResultWithVariant,
): Promise<ParsedEvaluationResultWithVariant> {
  try {
    // Parse using the same logic as parseEvaluationResult
    const parsedResult = await parseEvaluationResult(result);

    // Add the variant_name to the parsed result
    const parsedResultWithVariant = {
      ...parsedResult,
      variant_name: result.variant_name,
    };
    return ParsedEvaluationResultWithVariantSchema.parse(
      parsedResultWithVariant,
    );
  } catch (error) {
    console.warn(
      "Failed to parse evaluation result with variant using structure-based detection:",
      error,
    );
    // Fallback to direct parsing if needed
    return ParsedEvaluationResultWithVariantSchema.parse({
      ...result,
      input: result.input,
      generated_output: result.generated_output,
      reference_output: result.reference_output,
    });
  }
}

const getEvaluationResultDatapointIdsQuery = `
  SELECT DISTINCT dp.id as dp_id
  FROM {datapoint_table_name:Identifier} dp
  INNER JOIN TagInference datapoint_tag
    ON dp.id = toUUIDOrNull(datapoint_tag.value)
    AND datapoint_tag.key = 'tensorzero::datapoint_id'
    AND datapoint_tag.function_name = {function_name:String}
  INNER JOIN {inference_table_name:Identifier} ci
    ON ci.id = datapoint_tag.inference_id
    AND ci.function_name = {function_name:String}
  WHERE dp.function_name = {function_name:String}
    AND (ci.tags['tensorzero::evaluation_run_id'] IS NULL OR
         ci.tags['tensorzero::evaluation_run_id'] IN ({evaluation_run_ids:Array(String)}))
  ORDER BY toUInt128(toUUID(dp.id)) DESC
`;

export async function getEvaluationResults(
  function_name: string,
  function_type: "chat" | "json",
  metric_names: string[],
  evaluation_run_ids: string[],
  limit: number = 100,
  offset: number = 0,
) {
  const datapoint_table_name =
    function_type === "chat"
      ? "ChatInferenceDatapoint"
      : "JsonInferenceDatapoint";
  const inference_table_name =
    function_type === "chat" ? "ChatInference" : "JsonInference";
  const query = `
  SELECT
    dp.input as input,
    dp.id as datapoint_id,
    dp.output as reference_output,
    ci.output as generated_output,
    ci.tags['tensorzero::evaluation_run_id'] as evaluation_run_id,
    ci.tags['tensorzero::dataset_name'] as dataset_name,
    feedback.metric_name as metric_name,
    feedback.value as metric_value
  FROM (
    ${getEvaluationResultDatapointIdsQuery}
    LIMIT {limit:UInt32}
    OFFSET {offset:UInt32}
  ) paginated_dp
  INNER JOIN {datapoint_table_name:Identifier} dp
    ON dp.id = paginated_dp.dp_id
  INNER JOIN TagInference datapoint_tag FINAL
    ON dp.id = toUUIDOrNull(datapoint_tag.value)
    AND datapoint_tag.key = 'tensorzero::datapoint_id'
    AND datapoint_tag.function_name = {function_name:String}
  INNER JOIN {inference_table_name:Identifier} ci
    ON datapoint_tag.inference_id = ci.id
    AND ci.function_name = {function_name:String}
    AND ci.variant_name = datapoint_tag.variant_name
    AND ci.episode_id = datapoint_tag.episode_id
  INNER JOIN (
    SELECT target_id, metric_name, toString(value) as value
    FROM BooleanMetricFeedback
    WHERE metric_name IN ({metric_names:Array(String)})
    UNION ALL
    SELECT target_id, metric_name, toString(value) as value
    FROM FloatMetricFeedback
    WHERE metric_name IN ({metric_names:Array(String)})
  ) feedback
    ON feedback.target_id = ci.id
  WHERE
    (ci.tags['tensorzero::evaluation_run_id'] IS NULL OR
     ci.tags['tensorzero::evaluation_run_id'] IN ({evaluation_run_ids:Array(String)}))
  `;

  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      evaluation_run_ids: evaluation_run_ids,
      metric_names: metric_names,
      function_name: function_name,
      datapoint_table_name: datapoint_table_name,
      inference_table_name: inference_table_name,
      limit: limit,
      offset: offset,
    },
  });
  const rows = await result.json<EvaluationResult>();
  return Promise.all(rows.map((row) => parseEvaluationResult(row)));
}

/*
For each evaluation run and metric, we want to know:
 - how many datapoints were used
 - what was the mean and stderr of the metric value
*/
export async function getEvaluationStatistics(
  function_name: string,
  function_type: "chat" | "json",
  metric_names: string[],
  evaluation_run_ids: string[],
) {
  const datapoint_table_name =
    function_type === "chat"
      ? "ChatInferenceDatapoint"
      : "JsonInferenceDatapoint";
  const inference_table_name =
    function_type === "chat" ? "ChatInference" : "JsonInference";
  const query = `
  SELECT
    ci.tags['tensorzero::evaluation_run_id'] AS evaluation_run_id,
    feedback.metric_name AS metric_name,
    toUInt32(count()) AS datapoint_count,
    avg(toFloat64(feedback.value)) AS mean_metric,
    stddevSamp(toFloat64(feedback.value)) / sqrt(count()) AS stderr_metric
  FROM (
    ${getEvaluationResultDatapointIdsQuery}
  ) dp
  INNER JOIN TagInference datapoint_tag FINAL
    ON dp_id = toUUIDOrNull(datapoint_tag.value)
    AND datapoint_tag.key = 'tensorzero::datapoint_id'
    AND datapoint_tag.function_name = {function_name:String}
  INNER JOIN {inference_table_name:Identifier} ci
    ON datapoint_tag.inference_id = ci.id
    AND ci.function_name = {function_name:String}
    AND ci.variant_name = datapoint_tag.variant_name
    AND ci.episode_id = datapoint_tag.episode_id
  INNER JOIN (
    SELECT target_id, metric_name, value
    FROM BooleanMetricFeedback
    WHERE metric_name IN ({metric_names:Array(String)})
    UNION ALL
    SELECT target_id, metric_name, value
    FROM FloatMetricFeedback
    WHERE metric_name IN ({metric_names:Array(String)})
  ) feedback
    ON feedback.target_id = ci.id
  WHERE
     ci.tags['tensorzero::evaluation_run_id'] IN ({evaluation_run_ids:Array(String)})
    AND feedback.value IS NOT NULL
  GROUP BY
    ci.tags['tensorzero::evaluation_run_id'],
    feedback.metric_name
  ORDER BY
    toUInt128(toUUID(ci.tags['tensorzero::evaluation_run_id'])) DESC
  `;

  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      evaluation_run_ids: evaluation_run_ids,
      metric_names: metric_names,
      function_name: function_name,
      datapoint_table_name: datapoint_table_name,
      inference_table_name: inference_table_name,
    },
  });
  const rows = await result.json<EvaluationStatistics>();
  return rows.map((row) => EvaluationStatisticsSchema.parse(row));
}

export async function countDatapointsForEvaluation(
  function_name: string,
  function_type: "chat" | "json",
  evaluation_run_ids: string[],
) {
  const datapoint_table_name =
    function_type === "chat"
      ? "ChatInferenceDatapoint"
      : "JsonInferenceDatapoint";
  const inference_table_name =
    function_type === "chat" ? "ChatInference" : "JsonInference";

  const query = `
      SELECT toUInt32(count()) as count
      FROM (
        ${getEvaluationResultDatapointIdsQuery}
      )
  `;

  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      function_name: function_name,
      datapoint_table_name: datapoint_table_name,
      inference_table_name: inference_table_name,
      evaluation_run_ids: evaluation_run_ids,
    },
  });
  const rows = await result.json<{ count: number }>();
  return rows[0].count;
}

export async function countTotalEvaluationRuns() {
  const query = `
    SELECT toUInt32(uniqExact(value)) as count FROM TagInference WHERE key = 'tensorzero::evaluation_run_id'
  `;
  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ count: number }>();
  return rows[0].count;
}

export async function getEvaluationRunInfo(
  limit: number = 100,
  offset: number = 0,
) {
  const query = `
    SELECT
    evaluation_run_id,
    any(evaluation_name) AS evaluation_name,
    any(inference_function_name) AS function_name,
    any(variant_name) AS variant_name,
    any(dataset_name) AS dataset_name,
    formatDateTime(UUIDv7ToDateTime(uint_to_uuid(max(max_inference_id))), '%Y-%m-%dT%H:%i:%SZ') AS last_inference_timestamp
FROM (
    SELECT
        maxIf(value, key = 'tensorzero::evaluation_run_id') AS evaluation_run_id,
        maxIf(value, key = 'tensorzero::evaluation_name') AS evaluation_name,
        maxIf(value, key = 'tensorzero::dataset_name') AS dataset_name,
        any(function_name) AS inference_function_name,
        any(variant_name) AS variant_name,
        max(toUInt128(inference_id)) AS max_inference_id
    FROM TagInference
    WHERE key IN ('tensorzero::evaluation_run_id', 'tensorzero::evaluation_name', 'tensorzero::dataset_name')
    GROUP BY inference_id
)
WHERE NOT startsWith(inference_function_name, 'tensorzero::')
GROUP BY evaluation_run_id
ORDER BY toUInt128(toUUID(evaluation_run_id)) DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
  `;
  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      limit: limit,
      offset: offset,
    },
  });
  const rows = await result.json<EvaluationInfoResult>();
  return rows.map((row) => evaluationInfoResultSchema.parse(row));
}

/*
Returns a map of evaluation run ids to their most recent inference dates.
For each evaluation run id, returns the maximum of:
1. The timestamp from the evaluation run id itself (derived from UUIDv7)
2. The timestamp of the most recent inference associated with that evaluation run id
*/
export async function getMostRecentEvaluationInferenceDate(
  evaluation_run_ids: string[],
): Promise<Map<string, Date>> {
  const query = `
  SELECT
    value as evaluation_run_id,
    formatDateTime(max(UUIDv7ToDateTime(inference_id)), '%Y-%m-%dT%H:%i:%SZ') as last_inference_timestamp
  FROM TagInference
  WHERE key = 'tensorzero::evaluation_run_id'
    AND value IN ({evaluation_run_ids:Array(String)})
  GROUP BY value
  `;
  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      evaluation_run_ids: evaluation_run_ids,
    },
  });

  const rows = await result.json<{
    evaluation_run_id: string;
    last_inference_timestamp: string;
  }>();

  // Create a map of evaluation_run_id to its last inference timestamp
  const inferenceTimestampMap = new Map<string, Date>();
  rows.forEach((row) => {
    inferenceTimestampMap.set(
      row.evaluation_run_id,
      new Date(row.last_inference_timestamp),
    );
  });

  // For each evaluation_run_id, determine the max of its UUID timestamp and its last inference timestamp
  // This handles the case where the evaluation run id is newer than the last inference timestamp
  // Only possible if there are no inferences for that evaluation run id yet (we should still return the evaluation run id timestamp)
  const resultMap = new Map<string, Date>();
  evaluation_run_ids.forEach((id) => {
    const uuidTimestamp = uuidv7ToTimestamp(id);
    const inferenceTimestamp =
      inferenceTimestampMap.get(id) || new Date("1970-01-01T00:00:00Z");
    resultMap.set(
      id,
      uuidTimestamp > inferenceTimestamp ? uuidTimestamp : inferenceTimestamp,
    );
  });

  return resultMap;
}

export async function searchEvaluationRuns(
  evaluation_name: string,
  function_name: string,
  search_query: string,
  limit: number = 100,
  offset: number = 0,
) {
  // This query is not efficient since it is joining on the inference id.
  // We should rewrite this with some kind of MV for performance reasons if it becomes a bottleneck.
  const query = `
    SELECT DISTINCT run_tag.value as evaluation_run_id, run_tag.variant_name as variant_name
    FROM TagInference AS name_tag
    INNER JOIN TagInference AS run_tag
      ON name_tag.inference_id = run_tag.inference_id
    WHERE name_tag.key = 'tensorzero::evaluation_name'
      AND name_tag.value = {evaluation_name:String}
      AND run_tag.key = 'tensorzero::evaluation_run_id'
      AND run_tag.function_name = {function_name:String}
      AND (positionCaseInsensitive(run_tag.value, {search_query:String}) > 0 OR positionCaseInsensitive(run_tag.variant_name, {search_query:String}) > 0)
    ORDER BY toUInt128(toUUID(evaluation_run_id)) DESC
    LIMIT {limit:UInt32}
    OFFSET {offset:UInt32}
    `;

  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      evaluation_name: evaluation_name,
      function_name: function_name,
      limit: limit,
      offset: offset,
      search_query: search_query,
    },
  });
  const rows = await result.json<EvaluationRunInfo[]>();
  return rows.map((row) => EvaluationRunInfoSchema.parse(row));
}

export async function getEvaluationsForDatapoint(
  evaluation_name: string,
  datapoint_id: string,
  evaluation_run_ids: string[],
): Promise<ParsedEvaluationResultWithVariant[]> {
  const config = await getConfig();
  const function_name = config.evaluations[evaluation_name].function_name;
  if (!function_name) {
    throw new Error(`evaluation ${evaluation_name} not found in config`);
  }
  const function_config = config.functions[function_name];
  const function_type = function_config.type;
  const inference_table_name =
    function_type === "chat" ? "ChatInference" : "JsonInference";
  const datapoint_table_name =
    function_type === "chat"
      ? "ChatInferenceDatapoint"
      : "JsonInferenceDatapoint";

  const evaluators = config.evaluations[evaluation_name].evaluators;
  const metric_names = Object.keys(evaluators).map((evaluatorName) =>
    getEvaluatorMetricName(evaluation_name, evaluatorName),
  );

  const query = `
  SELECT
    inference.input as input,
    dp.id as datapoint_id,
    dp.output as reference_output,
    inference.output as generated_output,
    inference.tags['tensorzero::evaluation_run_id'] as evaluation_run_id,
    inference.variant_name as variant_name,
    inference.tags['tensorzero::dataset_name'] as dataset_name,
    feedback.metric_name as metric_name,
    feedback.value as metric_value
  FROM TagInference datapoint_tag FINAL
  JOIN {inference_table_name:Identifier} inference
    ON datapoint_tag.inference_id = inference.id
    AND inference.function_name = {function_name:String}
    AND inference.variant_name = datapoint_tag.variant_name
    AND inference.episode_id = datapoint_tag.episode_id
  JOIN {datapoint_table_name:Identifier} dp
    ON dp.id = toUUIDOrNull(datapoint_tag.value)
    AND dp.function_name = {function_name:String}
    AND dp.dataset_name = inference.tags['tensorzero::dataset_name']
  LEFT JOIN (
    SELECT target_id, metric_name, toString(value) as value
    FROM BooleanMetricFeedback
    WHERE metric_name IN ({metric_names:Array(String)})
    UNION ALL
    SELECT target_id, metric_name, toString(value) as value
    FROM FloatMetricFeedback
    WHERE metric_name IN ({metric_names:Array(String)})
  ) feedback
    ON feedback.target_id = inference.id
  WHERE datapoint_tag.key = 'tensorzero::datapoint_id'
    AND datapoint_tag.value = {datapoint_id:String}
    AND inference.tags['tensorzero::evaluation_run_id'] IN ({evaluation_run_ids:Array(String)})
  `;

  const result = await clickhouseClient.query({
    query,
    format: "JSONEachRow",
    query_params: {
      function_name,
      metric_names,
      datapoint_id,
      evaluation_run_ids,
      inference_table_name,
      datapoint_table_name,
    },
  });
  const rows = await result.json<EvaluationResultWithVariant>();
  const parsed_rows = await Promise.all(
    rows.map((row) => parseEvaluationResultWithVariant(row)),
  );
  return parsed_rows;
}
