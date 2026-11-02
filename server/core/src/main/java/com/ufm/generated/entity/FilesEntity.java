package com.ufm.generated.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.io.Serializable;
import java.lang.String;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * <p>
 *
 * </p>
 *
 * @author UFM Generator
 * @since 2026-10-30
 */
@TableName("files")
public class FilesEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.INPUT)
    private UUID id;

    @TableField("project_id")
    private UUID projectId;

    @TableField("storage_config_id")
    private UUID storageConfigId;

    @TableField("original_name")
    private String originalName;

    @TableField("storage_key")
    private String storageKey;

    @TableField("mime")
    private String mime;

    @TableField("ext")
    private String ext;

    @TableField("size")
    private Long size;

    @TableField("category")
    private String category;

    @TableField("status")
    private String status;

    @TableField("is_public")
    private Boolean isPublic;

    @TableField("checksum")
    private String checksum;

    @TableField("content_text")
    private String contentText;

    /**
     * Application-tokenized text. The future upload pipeline writes jieba tokens here.
     */
    @TableField("search_text")
    private String searchText;

    /**
     * Generated simple-configuration tsvector over search_text with content_text fallback.
     */
    @TableField("content_tsv")
    private Object contentTsv;

    @TableField("tags")
    private String tags;

    private String note;

    public String getNote() { return note; }
    public void setNote(String note) { this.note=note; }

    @TableField("folder_path")
    private String folderPath;

    @TableField("thumb_url")
    private String thumbUrl;

    @TableField("duplicate_of")
    private UUID duplicateOf;

    @TableField("version")
    private Integer version;

    @TableField("purge_at")
    private OffsetDateTime purgeAt;

    @TableField("created_at")
    private OffsetDateTime createdAt;

    @TableField("updated_at")
    private OffsetDateTime updatedAt;

    @TableField("deleted_at")
    private OffsetDateTime deletedAt;

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public UUID getProjectId() {
        return projectId;
    }

    public void setProjectId(UUID projectId) {
        this.projectId = projectId;
    }

    public UUID getStorageConfigId() {
        return storageConfigId;
    }

    public void setStorageConfigId(UUID storageConfigId) {
        this.storageConfigId = storageConfigId;
    }

    public String getOriginalName() {
        return originalName;
    }

    public void setOriginalName(String originalName) {
        this.originalName = originalName;
    }

    public String getStorageKey() {
        return storageKey;
    }

    public void setStorageKey(String storageKey) {
        this.storageKey = storageKey;
    }

    public String getMime() {
        return mime;
    }

    public void setMime(String mime) {
        this.mime = mime;
    }

    public String getExt() {
        return ext;
    }

    public void setExt(String ext) {
        this.ext = ext;
    }

    public Long getSize() {
        return size;
    }

    public void setSize(Long size) {
        this.size = size;
    }

    public String getCategory() {
        return category;
    }

    public void setCategory(String category) {
        this.category = category;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Boolean getIsPublic() {
        return isPublic;
    }

    public void setIsPublic(Boolean isPublic) {
        this.isPublic = isPublic;
    }

    public String getChecksum() {
        return checksum;
    }

    public void setChecksum(String checksum) {
        this.checksum = checksum;
    }

    public String getContentText() {
        return contentText;
    }

    public void setContentText(String contentText) {
        this.contentText = contentText;
    }

    public String getSearchText() {
        return searchText;
    }

    public void setSearchText(String searchText) {
        this.searchText = searchText;
    }

    public Object getContentTsv() {
        return contentTsv;
    }

    public void setContentTsv(Object contentTsv) {
        this.contentTsv = contentTsv;
    }

    public String getTags() {
        return tags;
    }

    public void setTags(String tags) {
        this.tags = tags;
    }

    public String getFolderPath() {
        return folderPath;
    }

    public void setFolderPath(String folderPath) {
        this.folderPath = folderPath;
    }

    public String getThumbUrl() {
        return thumbUrl;
    }

    public void setThumbUrl(String thumbUrl) {
        this.thumbUrl = thumbUrl;
    }

    public UUID getDuplicateOf() {
        return duplicateOf;
    }

    public void setDuplicateOf(UUID duplicateOf) {
        this.duplicateOf = duplicateOf;
    }

    public Integer getVersion() {
        return version;
    }

    public void setVersion(Integer version) {
        this.version = version;
    }

    public OffsetDateTime getPurgeAt() {
        return purgeAt;
    }

    public void setPurgeAt(OffsetDateTime purgeAt) {
        this.purgeAt = purgeAt;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }

    public OffsetDateTime getDeletedAt() {
        return deletedAt;
    }

    public void setDeletedAt(OffsetDateTime deletedAt) {
        this.deletedAt = deletedAt;
    }

    @Override
    public String toString() {
        return "FilesEntity{" +
            "id = " + id +
            ", projectId = " + projectId +
            ", storageConfigId = " + storageConfigId +
            ", originalName = " + originalName +
            ", storageKey = " + storageKey +
            ", mime = " + mime +
            ", ext = " + ext +
            ", size = " + size +
            ", category = " + category +
            ", status = " + status +
            ", isPublic = " + isPublic +
            ", checksum = " + checksum +
            ", contentText = " + contentText +
            ", searchText = " + searchText +
            ", contentTsv = " + contentTsv +
            ", tags = " + tags +
            ", folderPath = " + folderPath +
            ", thumbUrl = " + thumbUrl +
            ", duplicateOf = " + duplicateOf +
            ", version = " + version +
            ", purgeAt = " + purgeAt +
            ", createdAt = " + createdAt +
            ", updatedAt = " + updatedAt +
            ", deletedAt = " + deletedAt +
        "}";
    }
}
