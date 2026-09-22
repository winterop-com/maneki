"""Audiobooks: import raw rips into `Audiobooks/<Author>/<Title>/`, with chapters, tags and a cover.

A book is kept as the audio it arrived as. The import copies the files,
writes tags and chapters into them (for MP3, ID3 frames that leave every
audio frame untouched) and adds a `cover.jpg`. Nothing is re-encoded.
"""
