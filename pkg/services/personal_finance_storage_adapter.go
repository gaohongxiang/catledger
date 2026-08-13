package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"

	"github.com/minio/minio-go/v7"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/errs"
	"github.com/mayswind/ezbookkeeping/pkg/httpclient"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
	"github.com/mayswind/ezbookkeeping/pkg/storage"
)

const (
	personalFinanceImportStoragePrefix = "personal_finance/import_files"
	personalFinanceTemporaryKeyPrefix  = "temporary"
	personalFinanceAvailableKeyPrefix  = "objects"
	personalFinanceOpaqueKeyHexLength  = 64
	personalFinanceMaximumReadBytes    = int64(128 * 1024 * 1024)
)

// PersonalFinanceStorageAdapter 是原文件存储的窄适配器。
// 它只接受服务生成的不透明 key，避免原文件名或账户标识进入对象路径。
type PersonalFinanceStorageAdapter struct {
	config        *settings.ConfigContainer
	mutex         sync.Mutex
	objectStorage storage.ObjectStorage
}

// ReadAvailable 读取最终对象并在同一次流式读取中核对长度与 SHA-256。
// 返回值只在内存中交给解析器，不进入日志或响应。
func (s *PersonalFinanceStorageAdapter) ReadAvailable(c core.Context, objectKey string, expectedSHA256 string, expectedSize int64) ([]byte, error) {
	if !isPersonalFinanceObjectKey(objectKey, personalFinanceAvailableKeyPrefix) ||
		!isLowerHexDigest(expectedSHA256) || expectedSize < 1 || s == nil || s.config == nil {
		return nil, errs.ErrParameterInvalid
	}

	if expectedSize > personalFinanceMaximumReadBytes {
		return nil, errs.ErrParameterInvalid
	}

	objectStorage, err := s.currentStorage()
	if err != nil {
		return nil, err
	}

	object, err := objectStorage.Read(c, objectKey)
	if err != nil {
		return nil, err
	}
	defer object.Close()

	content, err := io.ReadAll(io.LimitReader(object, expectedSize+1))
	if err != nil {
		return nil, err
	}

	digest := sha256.Sum256(content)
	if int64(len(content)) != expectedSize || hex.EncodeToString(digest[:]) != expectedSHA256 {
		return nil, errs.ErrOperationFailed
	}

	return content, nil
}

// PersonalFinanceImportFilesStorage 是 API 组合根使用的默认原文件存储适配器。
var PersonalFinanceImportFilesStorage = &PersonalFinanceStorageAdapter{
	config: settings.Container,
}

// SaveTemporary 保存上传中的临时对象。
func (s *PersonalFinanceStorageAdapter) SaveTemporary(c core.Context, temporaryObjectKey string, content []byte) error {
	if !isPersonalFinanceObjectKey(temporaryObjectKey, personalFinanceTemporaryKeyPrefix) {
		return errs.ErrParameterInvalid
	}

	objectStorage, err := s.currentStorage()

	if err != nil {
		return err
	}

	return objectStorage.Save(c, temporaryObjectKey, newPersonalFinanceByteObject(content))
}

// Promote 将临时对象完整复制到最终对象 key。
func (s *PersonalFinanceStorageAdapter) Promote(c core.Context, temporaryObjectKey string, availableObjectKey string) error {
	if !isPersonalFinanceObjectKey(temporaryObjectKey, personalFinanceTemporaryKeyPrefix) ||
		!isPersonalFinanceObjectKey(availableObjectKey, personalFinanceAvailableKeyPrefix) {
		return errs.ErrParameterInvalid
	}

	objectStorage, err := s.currentStorage()

	if err != nil {
		return err
	}

	temporaryObject, err := objectStorage.Read(c, temporaryObjectKey)

	if err != nil {
		return err
	}

	defer temporaryObject.Close()
	return objectStorage.Save(c, availableObjectKey, temporaryObject)
}

// Verify 校验一个受限 PF 原文件对象的长度与 SHA-256，防止半写对象进入完成态。
func (s *PersonalFinanceStorageAdapter) Verify(c core.Context, objectKey string, expectedSHA256 string, expectedSize int64) (bool, error) {
	if !isPersonalFinanceObjectKey(objectKey, personalFinanceTemporaryKeyPrefix) &&
		!isPersonalFinanceObjectKey(objectKey, personalFinanceAvailableKeyPrefix) {
		return false, errs.ErrParameterInvalid
	}

	if !isLowerHexDigest(expectedSHA256) || expectedSize < 0 || expectedSize > int64(^uint32(0)) {
		return false, errs.ErrParameterInvalid
	}

	objectStorage, err := s.currentStorage()

	if err != nil {
		return false, err
	}

	exists, err := objectStorage.Exists(c, objectKey)

	if err != nil {
		if isObjectNotFoundError(err) {
			return false, nil
		}

		return false, err
	}

	if !exists {
		return false, nil
	}

	object, err := objectStorage.Read(c, objectKey)

	if err != nil {
		if isObjectNotFoundError(err) {
			return false, nil
		}

		return false, err
	}

	defer object.Close()
	digest := sha256.New()
	readSize, err := io.Copy(digest, io.LimitReader(object, expectedSize+1))

	if err != nil {
		if isObjectNotFoundError(err) {
			return false, nil
		}

		return false, err
	}

	return readSize == expectedSize && hex.EncodeToString(digest.Sum(nil)) == expectedSHA256, nil
}

// Delete 删除一个受限 PF 原文件对象。
func (s *PersonalFinanceStorageAdapter) Delete(c core.Context, objectKey string) error {
	if !isPersonalFinanceObjectKey(objectKey, personalFinanceTemporaryKeyPrefix) &&
		!isPersonalFinanceObjectKey(objectKey, personalFinanceAvailableKeyPrefix) {
		return errs.ErrParameterInvalid
	}

	objectStorage, err := s.currentStorage()

	if err != nil {
		return err
	}

	err = objectStorage.Delete(c, objectKey)

	if isObjectNotFoundError(err) {
		return nil
	}

	return err
}

func (s *PersonalFinanceStorageAdapter) currentStorage() (storage.ObjectStorage, error) {
	if s == nil || s.config == nil {
		return nil, errs.ErrSystemError
	}

	s.mutex.Lock()
	defer s.mutex.Unlock()

	if s.objectStorage != nil {
		return s.objectStorage, nil
	}

	config := s.config.GetCurrentConfig()

	if config == nil {
		return nil, errs.ErrSystemError
	}

	var objectStorage storage.ObjectStorage
	var err error

	switch config.StorageType {
	case settings.LocalFileSystemObjectStorageType:
		objectStorage, err = storage.NewLocalFileSystemObjectStorage(config, personalFinanceImportStoragePrefix)
	case settings.MinIOStorageType:
		if config.MinIOConfig == nil {
			return nil, errs.ErrSystemError
		}

		objectStorage, err = storage.NewMinIOObjectStorage(config, personalFinanceImportStoragePrefix)
	case settings.WebDAVStorageType:
		if config.WebDAVConfig == nil {
			return nil, errs.ErrSystemError
		}

		// 通用 WebDAV 存储会在部分失败路径记录响应体；PF 原文件必须使用无正文日志实现。
		objectStorage, err = newPersonalFinanceWebDAVObjectStorage(config, personalFinanceImportStoragePrefix)
	default:
		return nil, errs.ErrInvalidStorageType
	}

	if err != nil {
		// 初始化失败不缓存，后续同哈希重传仍可重新建立存储连接。
		return nil, err
	}

	s.objectStorage = objectStorage
	return objectStorage, nil
}

func isPersonalFinanceObjectKey(objectKey string, expectedPrefix string) bool {
	parts := strings.Split(objectKey, "/")

	if len(parts) != 2 || parts[0] != expectedPrefix || len(parts[1]) != personalFinanceOpaqueKeyHexLength ||
		parts[1] != strings.ToLower(parts[1]) {
		return false
	}

	decoded, err := hex.DecodeString(parts[1])
	return err == nil && len(decoded)*2 == personalFinanceOpaqueKeyHexLength
}

func isLowerHexDigest(digest string) bool {
	if len(digest) != sha256.Size*2 || digest != strings.ToLower(digest) {
		return false
	}

	decoded, err := hex.DecodeString(digest)
	return err == nil && len(decoded) == sha256.Size
}

func isObjectNotFoundError(err error) bool {
	if err == nil {
		return false
	}

	if errors.Is(err, os.ErrNotExist) {
		return true
	}

	response := minio.ToErrorResponse(err)
	return response.StatusCode == http.StatusNotFound ||
		response.Code == "NoSuchKey" ||
		response.Code == "NoSuchObject" ||
		response.Code == "NotFound"
}

type personalFinanceByteObject struct {
	*bytes.Reader
}

func newPersonalFinanceByteObject(content []byte) *personalFinanceByteObject {
	return &personalFinanceByteObject{Reader: bytes.NewReader(content)}
}

func (o *personalFinanceByteObject) Close() error {
	return nil
}

// personalFinanceWebDAVObjectStorage 是仅供原文件使用的无正文日志 WebDAV 实现。
// 服务错误由上层转成稳定错误；这里不记录响应体、原文件字节或认证信息。
type personalFinanceWebDAVObjectStorage struct {
	httpClient    *http.Client
	webDAVConfig  *settings.WebDAVConfig
	rootPath      string
	maxObjectSize int64
}

func newPersonalFinanceWebDAVObjectStorage(config *settings.Config, pathPrefix string) (*personalFinanceWebDAVObjectStorage, error) {
	if config == nil || config.WebDAVConfig == nil || config.MaxImportFileSize < 1 {
		return nil, errs.ErrSystemError
	}

	objectStorage := &personalFinanceWebDAVObjectStorage{
		httpClient: httpclient.NewHttpClient(
			config.WebDAVConfig.RequestTimeout,
			config.WebDAVConfig.Proxy,
			config.WebDAVConfig.SkipTLSVerify,
			core.GetOutgoingUserAgent(),
			false,
		),
		webDAVConfig:  config.WebDAVConfig,
		rootPath:      config.WebDAVConfig.RootPath,
		maxObjectSize: int64(config.MaxImportFileSize),
	}
	objectStorage.rootPath = strings.ReplaceAll(objectStorage.finalPath(pathPrefix), "\\", "/")

	if err := objectStorage.createAllDirectories(core.NewNullContext(), "", objectStorage.rootPath); err != nil {
		return nil, err
	}

	return objectStorage, nil
}

func (s *personalFinanceWebDAVObjectStorage) Exists(c core.Context, objectKey string) (bool, error) {
	response, err := s.do(c, http.MethodHead, s.finalFileURL(objectKey), nil)

	if err != nil {
		return false, err
	}

	defer closePersonalFinanceHTTPResponse(response)

	switch response.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, errs.ErrSystemError
	}
}

func (s *personalFinanceWebDAVObjectStorage) Read(c core.Context, objectKey string) (storage.ObjectInStorage, error) {
	response, err := s.do(c, http.MethodGet, s.finalFileURL(objectKey), nil)

	if err != nil {
		return nil, err
	}

	defer response.Body.Close()

	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return nil, os.ErrNotExist
	}

	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return nil, errs.ErrSystemError
	}

	content, err := io.ReadAll(io.LimitReader(response.Body, s.maxObjectSize+1))

	if err != nil || int64(len(content)) > s.maxObjectSize {
		return nil, errs.ErrSystemError
	}

	return newPersonalFinanceByteObject(content), nil
}

func (s *personalFinanceWebDAVObjectStorage) Save(c core.Context, objectKey string, object storage.ObjectInStorage) error {
	content, err := io.ReadAll(io.LimitReader(object, s.maxObjectSize+1))

	if err != nil || int64(len(content)) > s.maxObjectSize {
		return errs.ErrSystemError
	}

	directory := path.Dir(s.finalPath(objectKey))

	if err := s.createAllDirectories(c, "", directory); err != nil {
		return err
	}

	response, err := s.do(c, http.MethodPut, s.finalFileURL(objectKey), bytes.NewReader(content))

	if err != nil {
		return err
	}

	defer closePersonalFinanceHTTPResponse(response)

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return errs.ErrSystemError
	}

	return nil
}

func (s *personalFinanceWebDAVObjectStorage) Delete(c core.Context, objectKey string) error {
	response, err := s.do(c, http.MethodDelete, s.finalFileURL(objectKey), nil)

	if err != nil {
		return err
	}

	defer closePersonalFinanceHTTPResponse(response)

	if response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusNotFound {
		return errs.ErrSystemError
	}

	return nil
}

func (s *personalFinanceWebDAVObjectStorage) directoryExists(c core.Context, directory string) (bool, error) {
	response, err := s.do(c, "PROPFIND", s.finalDirectoryURL(directory), nil)

	if err != nil {
		return false, err
	}

	defer closePersonalFinanceHTTPResponse(response)

	switch response.StatusCode {
	case http.StatusMultiStatus, http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, errs.ErrSystemError
	}
}

func (s *personalFinanceWebDAVObjectStorage) createDirectory(c core.Context, directory string) error {
	response, err := s.do(c, "MKCOL", s.finalDirectoryURL(directory), nil)

	if err != nil {
		return err
	}

	defer closePersonalFinanceHTTPResponse(response)

	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusMethodNotAllowed {
		return errs.ErrSystemError
	}

	return nil
}

func (s *personalFinanceWebDAVObjectStorage) createAllDirectories(c core.Context, currentPath string, directory string) error {
	for _, segment := range strings.Split(directory, "/") {
		if segment == "" {
			continue
		}

		currentPath += "/" + segment
		exists, err := s.directoryExists(c, currentPath)

		if err != nil {
			return err
		}

		if !exists {
			if err := s.createDirectory(c, currentPath); err != nil {
				return err
			}
		}
	}

	return nil
}

func (s *personalFinanceWebDAVObjectStorage) do(c core.Context, method string, requestURL string, body io.Reader) (*http.Response, error) {
	requestContext := context.Background()

	if c != nil {
		requestContext = c
	}

	request, err := http.NewRequestWithContext(requestContext, method, requestURL, body)

	if err != nil {
		return nil, err
	}

	request.SetBasicAuth(s.webDAVConfig.Username, s.webDAVConfig.Password)
	return s.httpClient.Do(request)
}

func (s *personalFinanceWebDAVObjectStorage) finalFileURL(objectKey string) string {
	baseURL := s.webDAVConfig.Url

	if !strings.HasSuffix(baseURL, "/") {
		baseURL += "/"
	}

	return baseURL + strings.TrimPrefix(s.finalPath(objectKey), "/")
}

func (s *personalFinanceWebDAVObjectStorage) finalDirectoryURL(directory string) string {
	baseURL := s.webDAVConfig.Url

	if !strings.HasSuffix(baseURL, "/") {
		baseURL += "/"
	}

	return baseURL + strings.Trim(strings.ReplaceAll(directory, "\\", "/"), "/") + "/"
}

func (s *personalFinanceWebDAVObjectStorage) finalPath(objectKey string) string {
	rootPath := s.rootPath

	if !strings.HasSuffix(rootPath, "/") {
		rootPath += "/"
	}

	return rootPath + strings.TrimPrefix(strings.ReplaceAll(objectKey, "\\", "/"), "/")
}

func closePersonalFinanceHTTPResponse(response *http.Response) {
	if response == nil || response.Body == nil {
		return
	}

	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
	_ = response.Body.Close()
}
