package ceb

import (
	"bytes"
	"context"
	"fmt"

	"github.com/ledongthuc/pdf"
)

func extractPDFPageTexts(ctx context.Context, content []byte) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(content, []byte("%PDF")) {
		return nil, fmt.Errorf("not a pdf")
	}

	reader, err := pdf.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil || reader == nil {
		return nil, fmt.Errorf("open pdf")
	}

	count := reader.NumPage()
	if count < 1 {
		return nil, fmt.Errorf("empty pdf")
	}

	pages := make([]string, 0, count)
	for pageNumber := 1; pageNumber <= count; pageNumber++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		text, err := reader.Page(pageNumber).GetPlainText(nil)
		if err != nil {
			return nil, err
		}
		pages = append(pages, text)
	}
	return pages, nil
}
