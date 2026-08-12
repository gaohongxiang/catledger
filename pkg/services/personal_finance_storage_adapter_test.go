package services

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mayswind/ezbookkeeping/pkg/core"
	"github.com/mayswind/ezbookkeeping/pkg/settings"
	"github.com/mayswind/ezbookkeeping/pkg/storage"
)

func TestIsPersonalFinanceObjectKey(t *testing.T) {
	opaque := strings.Repeat("a", personalFinanceOpaqueKeyHexLength)

	if !isPersonalFinanceObjectKey("temporary/"+opaque, personalFinanceTemporaryKeyPrefix) {
		t.Fatalf("valid temporary object key was rejected")
	}

	if !isPersonalFinanceObjectKey("objects/"+opaque, personalFinanceAvailableKeyPrefix) {
		t.Fatalf("valid available object key was rejected")
	}

	invalidKeys := []string{
		"temporary/original-statement.csv",
		"temporary/../" + opaque,
		"temporary/" + strings.Repeat("A", personalFinanceOpaqueKeyHexLength),
		"temporary/" + strings.Repeat("g", personalFinanceOpaqueKeyHexLength),
		"temporary/" + strings.Repeat("a", personalFinanceOpaqueKeyHexLength-1),
		"other/" + opaque,
	}

	for _, objectKey := range invalidKeys {
		if isPersonalFinanceObjectKey(objectKey, personalFinanceTemporaryKeyPrefix) {
			t.Fatalf("unsafe object key was accepted")
		}
	}
}

func TestPersonalFinanceByteObjectPreservesContent(t *testing.T) {
	original := []byte{0x00, 0x01, 0x02, 0xff}
	object := newPersonalFinanceByteObject(original)
	buffer := make([]byte, len(original))

	if _, err := object.Read(buffer); err != nil {
		t.Fatalf("read byte object: %v", err)
	}

	for index := range original {
		if original[index] != buffer[index] {
			t.Fatalf("byte object changed content")
		}
	}

	if err := object.Close(); err != nil {
		t.Fatalf("close byte object: %v", err)
	}
}

func TestPersonalFinanceStorageAdapterLocalCompensationFlow(t *testing.T) {
	localStorage, err := storage.NewLocalFileSystemObjectStorage(&settings.Config{
		LocalFileSystemPath: t.TempDir(),
	}, personalFinanceImportStoragePrefix)

	if err != nil {
		t.Fatalf("create local import storage: %v", err)
	}

	adapter := &PersonalFinanceStorageAdapter{
		config:        settings.Container,
		objectStorage: localStorage,
	}
	temporaryKey := "temporary/" + strings.Repeat("a", personalFinanceOpaqueKeyHexLength)
	availableKey := "objects/" + strings.Repeat("b", personalFinanceOpaqueKeyHexLength)
	content := []byte{0x10, 0x20, 0x30, 0x40}
	digest := sha256.Sum256(content)
	digestText := hex.EncodeToString(digest[:])
	c := core.NewNullContext()

	if err := adapter.SaveTemporary(c, temporaryKey, content); err != nil {
		t.Fatalf("save temporary import object: %v", err)
	}

	valid, err := adapter.Verify(c, temporaryKey, digestText, int64(len(content)))

	if err != nil || !valid {
		t.Fatalf("verify temporary import object")
	}

	valid, err = adapter.Verify(c, temporaryKey, strings.Repeat("0", sha256.Size*2), int64(len(content)))

	if err != nil || valid {
		t.Fatalf("incorrect digest was accepted")
	}

	if err := adapter.Promote(c, temporaryKey, availableKey); err != nil {
		t.Fatalf("promote import object: %v", err)
	}

	valid, err = adapter.Verify(c, availableKey, digestText, int64(len(content)))

	if err != nil || !valid {
		t.Fatalf("verify available import object")
	}

	if err := adapter.Delete(c, temporaryKey); err != nil {
		t.Fatalf("delete temporary import object: %v", err)
	}

	if err := adapter.Delete(c, temporaryKey); err != nil {
		t.Fatalf("repeat temporary object deletion should be idempotent: %v", err)
	}

	valid, err = adapter.Verify(c, temporaryKey, digestText, int64(len(content)))

	if err != nil || valid {
		t.Fatalf("deleted temporary object remained available")
	}
}

func TestPersonalFinanceStorageAdapterPrivateWebDAVFlow(t *testing.T) {
	var mutex sync.Mutex
	directories := map[string]bool{"/": true}
	objects := make(map[string][]byte)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()

		switch request.Method {
		case "PROPFIND":
			if directories[request.URL.Path] {
				writer.WriteHeader(http.StatusMultiStatus)
			} else {
				writer.WriteHeader(http.StatusNotFound)
			}
		case "MKCOL":
			directories[request.URL.Path] = true
			writer.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			content, err := io.ReadAll(request.Body)

			if err != nil {
				writer.WriteHeader(http.StatusInternalServerError)
				return
			}

			objects[request.URL.Path] = content
			writer.WriteHeader(http.StatusCreated)
		case http.MethodHead:
			if objects[request.URL.Path] == nil {
				writer.WriteHeader(http.StatusNotFound)
			} else {
				writer.WriteHeader(http.StatusOK)
			}
		case http.MethodGet:
			content := objects[request.URL.Path]

			if content == nil {
				writer.WriteHeader(http.StatusNotFound)
				return
			}

			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write(content)
		case http.MethodDelete:
			delete(objects, request.URL.Path)
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(server.Close)

	webDAVStorage, err := newPersonalFinanceWebDAVObjectStorage(&settings.Config{
		MaxImportFileSize: 1024,
		WebDAVConfig: &settings.WebDAVConfig{
			Url:            server.URL,
			RootPath:       "pf-test",
			RequestTimeout: 5000,
			Proxy:          "none",
		},
	}, personalFinanceImportStoragePrefix)

	if err != nil {
		t.Fatalf("create private WebDAV import storage: %v", err)
	}

	adapter := &PersonalFinanceStorageAdapter{config: settings.Container, objectStorage: webDAVStorage}
	temporaryKey := "temporary/" + strings.Repeat("c", personalFinanceOpaqueKeyHexLength)
	availableKey := "objects/" + strings.Repeat("d", personalFinanceOpaqueKeyHexLength)
	content := []byte{0x51, 0x52, 0x53, 0x54}
	digest := sha256.Sum256(content)
	digestText := hex.EncodeToString(digest[:])
	c := core.NewNullContext()

	if err := adapter.SaveTemporary(c, temporaryKey, content); err != nil {
		t.Fatalf("save private WebDAV temporary object: %v", err)
	}

	if err := adapter.Promote(c, temporaryKey, availableKey); err != nil {
		t.Fatalf("promote private WebDAV object: %v", err)
	}

	valid, err := adapter.Verify(c, availableKey, digestText, int64(len(content)))

	if err != nil || !valid {
		t.Fatalf("verify private WebDAV object")
	}

	mutex.Lock()
	stored := append([]byte(nil), objects["/pf-test/personal_finance/import_files/objects/"+strings.Repeat("d", personalFinanceOpaqueKeyHexLength)]...)
	mutex.Unlock()

	if !bytes.Equal(stored, content) {
		t.Fatalf("private WebDAV storage changed raw bytes")
	}

	if err := adapter.Delete(c, temporaryKey); err != nil {
		t.Fatalf("delete private WebDAV temporary object: %v", err)
	}
}
