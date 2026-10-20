# ParseX 文档解析指南

ParseX 是阿里云百炼提供的文档解析与信息抽取服务，可以将 PDF、Word、Markdown 等文档解析为结构化的 Markdown 输出，也支持按 JSON Schema 进行结构化信息抽取。

## 服务地址与鉴权

ParseX 所有接口通过 DashScope 网关提供服务，统一服务地址为 https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v2/apps/parse-x，路径前缀为 /api/v2/apps/parse-x。

鉴权使用百炼 API Key：请求通过 Authorization Header 携带 Bearer $DASHSCOPE_API_KEY。API Key 在百炼控制台的 API Key 页创建，以 sk- 开头。系统根据 API Key 自动路由到对应业务空间。

## 异步调用流程

文档解析是异步任务，调用流程分为三步：第一步调用提交接口，提交文档或音视频解析任务，返回 biz_id；第二步使用该 biz_id 调用结果查询接口；第三步轮询查询直到 data.status 为 success 或 failed。

提交解析任务的接口为 POST /api/v2/apps/parse-x/parse/submit，查询结果的接口为 POST /api/v2/apps/parse-x/parse/result。

## 提交解析任务的参数

提交接口的核心参数包括：file_url 是必填参数，指定待解析文件的公网 URL；file_name 与 file_name_extension 二选一，用于告知文件信息；config_id 可选，指定已保存的解析配置 ID，与内联参数同时传递时内联参数优先生效。

processing 对象用于传递处理配置，其中 doc_processing_config 面向文档解析：page_index 指定解析页数范围（例如 1-10）；head_foot 控制是否解析页眉页脚；layout_position 控制是否返回坐标；image_caption 控制是否生成图片描述。

media_processing_config 面向音视频解析：enable_diarization 控制人声分离；enable_synopsis_parse、enable_synopsis_segments、enable_synopsis_summary 分别控制剧情解析、剧情段落与剧情摘要；frame_extraction 配置抽帧模式，mode 可选 auto 或 frame_rate，帧率范围为 0.2 到 5。

## 输出配置

output 对象控制输出：output_file_format 是输出格式字符串数组，目前可选值为 markdown；layout_table_format 指定 Markdown 中表格的输出格式，可选 markdown 或 html。

output 还支持 oss_config 托管 OSS 输出配置，包含 bucket、endpoint、access_key_id、access_key_secret 与 security_token 字段，可将解析结果直接写入指定 OSS Bucket。

## 结构化信息抽取

除文档解析外，ParseX 还支持按 JSON Schema 提交结构化信息抽取任务：调用 POST /api/v2/apps/parse-x/extract/submit 提交抽取任务，调用 POST /api/v2/apps/parse-x/extract/result 查询抽取状态与结果。抽取任务同样采用异步模型，返回 biz_id 供轮询。

## 通用响应格式

成功响应返回 request_id 和 data.biz_id；失败响应返回 code、message 与 request_id，例如 code 为 InvalidParameter 时表示参数缺失或非法。排查问题时可向技术支持提供 request_id 以快速定位。

## 最佳实践

解析大文件时建议先用 page_index 指定页数范围试跑，确认输出质量后再解析全文；需要保留版面结构（如表格）时，将 layout_table_format 设置为 markdown；对图片内容有理解需求时开启 image_caption 生成图片描述；API Key 请妥善保管，不要提交到代码仓库，建议使用环境变量存储并定期轮转。
