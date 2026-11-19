// Prüfhilfe für tools/check.js: schreibt und liest Tresore genau wie otp-vault (Format aus otp-vault/vault.go).
//
//   (cd tools/gocompat && go build -o /tmp/gocompat .) && GOCOMPAT=/tmp/gocompat node tools/check.js
//
// Erzeugt und liest Vault-Dateien mit dem Format-Code aus otp-vault/vault.go (seal/open unverändert übernommen).
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

type kdfParams struct {
	Name    string `json:"name"`
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"`
	Threads uint8  `json:"threads"`
	Salt    string `json:"salt"`
}
type sealedFile struct {
	Format  string    `json:"format"`
	Version int       `json:"version"`
	KDF     kdfParams `json:"kdf"`
	Cipher  string    `json:"cipher"`
	Nonce   string    `json:"nonce"`
	Data    string    `json:"data"`
}
type Entry struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Issuer    string `json:"issuer"`
	Account   string `json:"account"`
	Secret    string `json:"secret"`
	Algorithm string `json:"algorithm"`
	Digits    int    `json:"digits"`
	Period    int    `json:"period"`
	Counter   uint64 `json:"counter"`
	Website   string `json:"website,omitempty"`
	Icon      string `json:"icon,omitempty"`
	Note      string `json:"note,omitempty"`
	Favorite  bool   `json:"favorite,omitempty"`
	Created   int64  `json:"created"`
	Updated   int64  `json:"updated"`
}
type vaultData struct {
	Entries []Entry `json:"entries"`
	Saved   int64   `json:"saved"`
}

func ad(p kdfParams) []byte {
	return []byte(fmt.Sprintf("%s/%d/%s/%s/%d/%d/%d/%s", "otp-vault", 1, "xchacha20poly1305", p.Name, p.Time, p.Memory, p.Threads, p.Salt))
}

func main() {
	switch os.Args[1] {
	case "write":
		salt := make([]byte, 16)
		rand.Read(salt)
		p := kdfParams{Name: "argon2id", Time: 3, Memory: 64 * 1024, Threads: 4, Salt: base64.StdEncoding.EncodeToString(salt)}
		key := argon2.IDKey([]byte(os.Args[2]), salt, p.Time, p.Memory, p.Threads, 32)
		v := vaultData{Entries: []Entry{
			{ID: "a1", Kind: "totp", Issuer: "GitHub", Account: "ich@example.org", Secret: "JBSWY3DPEHPK3PXP", Algorithm: "SHA1", Digits: 6, Period: 30, Website: "github.com", Favorite: true, Created: 1, Updated: 2},
			{ID: "a2", Kind: "hotp", Issuer: "Bank", Account: "Müller", Secret: "GEZDGNBVGY3TQOJQ", Algorithm: "SHA256", Digits: 8, Period: 30, Counter: 7, Note: "Ä Ö Ü ß", Created: 3, Updated: 4},
			{ID: "a3", Kind: "steam", Issuer: "Steam", Account: "gamer", Secret: "MFRGGZDFMZTWQ2LK", Algorithm: "SHA1", Digits: 5, Period: 30, Icon: "data:image/png;base64,iVBORw0KGgo=", Created: 5, Updated: 6},
		}, Saved: 99}
		plain, _ := json.Marshal(v)
		aead, _ := chacha20poly1305.NewX(key)
		nonce := make([]byte, aead.NonceSize())
		rand.Read(nonce)
		out := aead.Seal(nil, nonce, plain, ad(p))
		b, _ := json.MarshalIndent(sealedFile{Format: "otp-vault", Version: 1, KDF: p, Cipher: "xchacha20poly1305",
			Nonce: base64.StdEncoding.EncodeToString(nonce), Data: base64.StdEncoding.EncodeToString(out)}, "", "  ")
		os.Stdout.Write(b)
	case "read":
		raw, _ := os.ReadFile(os.Args[2])
		var f sealedFile
		if err := json.Unmarshal(raw, &f); err != nil {
			panic(err)
		}
		salt, _ := base64.StdEncoding.DecodeString(f.KDF.Salt)
		key := argon2.IDKey([]byte(os.Args[3]), salt, f.KDF.Time, f.KDF.Memory, f.KDF.Threads, 32)
		aead, _ := chacha20poly1305.NewX(key)
		nonce, _ := base64.StdEncoding.DecodeString(f.Nonce)
		data, _ := base64.StdEncoding.DecodeString(f.Data)
		plain, err := aead.Open(nil, nonce, data, ad(f.KDF))
		if err != nil {
			fmt.Println("OPEN FAILED:", err)
			os.Exit(1)
		}
		var v vaultData
		if err := json.Unmarshal(plain, &v); err != nil {
			panic(err)
		}
		out, _ := json.Marshal(v)
		fmt.Println(string(out))
	}
}
